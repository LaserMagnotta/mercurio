// Progress-based leg pricing engine — Model B (ECONOMICS.md, ADR-006) with
// the finalization-bonus carve-out of ADR-014.
//
// Pure functions, zero I/O. All money is bigint msat (ADR-008); all rounding
// is downward (never overpay from someone else's commitment). Distances come
// in as km floats (DistanceProvider, ADR-007) and are quantized to integer
// meters so every division below is exact bigint arithmetic: two machines
// pricing the same leg MUST freeze the same msat amounts.
//
// ADR-014 changes the denominations, not the formulas: every sender
// commitment (offer P, each boost ΔP) is split ONCE at ingestion by
// splitCommitment into a 90% work part and the two bonus quotas (7% carrier,
// 3% hub). All pool math below — remainingPool, priceLeg's gross, hub fees,
// applyReroute, cancellationCompensation — runs exclusively on WORK amounts;
// the bonus quotas accrue per shipment and only surface here as priceLeg's
// carrierBonusMsat input, frozen onto the leg that reaches the destination.
//
// Rounding ladder (ECONOMICS.md, regole di contorno):
//   - distances: quantized to whole meters on input;
//   - the notional pool and the commitment split: truncated at msat precision;
//   - frozen amounts (gross, fees, bonus shares): floored to a whole sat.
// Truncation remainders stay with the sender as unspent commitment — there is
// no common pot to redistribute them from (ADR-013).

import type { LegPricing, Msat, PoolBoost, PoolSegment } from '@mercurio/shared';
import {
  FINALIZATION_BONUS_BP,
  FINALIZATION_CARRIER_SHARE_BP,
  FINALIZATION_HUB_SHARE_BP,
  HUB_FEE_BP_DENOMINATOR,
  MAX_HUB_FEE_BP,
  MIN_LEG_PROGRESS_KM,
  MIN_LEG_PROGRESS_RATIO,
  MSAT_PER_SAT,
} from '@mercurio/shared';

export type EconomicsErrorCode =
  | 'invalid_amount'
  | 'invalid_distance'
  | 'invalid_hub_fee'
  | 'invalid_boost'
  | 'progress_below_minimum'
  | 'progress_exceeds_remaining';

/** Typed error so the API can map violations to precise 4xx responses. */
export class EconomicsError extends Error {
  constructor(
    readonly code: EconomicsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EconomicsError';
  }
}

const BP_DENOMINATOR = BigInt(HUB_FEE_BP_DENOMINATOR);

/** Quantize a km distance to integer meters (exact bigint math downstream). */
function kmToMeters(km: number, field: string): bigint {
  if (!Number.isFinite(km) || km < 0) {
    throw new EconomicsError('invalid_distance', `${field} must be a finite km value >= 0, got ${km}`);
  }
  return BigInt(Math.round(km * 1000));
}

function assertNonNegativeMsat(amount: Msat, field: string): void {
  if (amount < 0n) {
    throw new EconomicsError('invalid_amount', `${field} must be >= 0 msat, got ${amount}`);
  }
}

function assertValidHubFeeBp(bp: number, field: string): bigint {
  if (!Number.isInteger(bp) || bp < 0 || bp > MAX_HUB_FEE_BP) {
    throw new EconomicsError(
      'invalid_hub_fee',
      `${field} must be an integer between 0 and ${MAX_HUB_FEE_BP} bp (${MAX_HUB_FEE_BP / 100}%), got ${bp}`,
    );
  }
  return BigInt(bp);
}

/** Floor an msat amount to a whole sat: invoices are denominated in sats (ADR-008). */
export function floorToSat(amount: Msat): Msat {
  assertNonNegativeMsat(amount, 'amount');
  return amount - (amount % MSAT_PER_SAT);
}

/**
 * How one sender commitment (the offer P at creation, each boost ΔP) splits
 * under ADR-014. The work part feeds the progress-based pool; the two bonus
 * parts accrue to the shipment's finalization-bonus quotas.
 */
export interface CommitmentSplit {
  /** 90% — the commitment's contribution to the work pool. */
  workMsat: Msat;
  /** Carrier quota Π_v accrual: 70% of the 10% bonus. */
  carrierBonusMsat: Msat;
  /** Destination-hub quota Π_h accrual: 30% of the 10% bonus. */
  hubBonusMsat: Msat;
}

/**
 * Split a commitment into work pool and finalization-bonus quotas (ADR-014).
 * Each part is truncated independently at msat precision (never rounded up:
 * the parts can only understate their exact shares), so
 * work + carrier + hub ≤ commitment always, with at most 2 msat of remainder
 * staying with the sender as unspent commitment. The split happens exactly
 * once per commitment event: a reroute freezes an already-split work pool and
 * must NOT be passed through here again.
 */
export function splitCommitment(amountMsat: Msat): CommitmentSplit {
  assertNonNegativeMsat(amountMsat, 'amountMsat');
  const bonusMsat = (amountMsat * BigInt(FINALIZATION_BONUS_BP)) / BP_DENOMINATOR;
  return {
    workMsat: (amountMsat * BigInt(HUB_FEE_BP_DENOMINATOR - FINALIZATION_BONUS_BP)) / BP_DENOMINATOR,
    carrierBonusMsat: (bonusMsat * BigInt(FINALIZATION_CARRIER_SHARE_BP)) / BP_DENOMINATOR,
    hubBonusMsat: (bonusMsat * BigInt(FINALIZATION_HUB_SHARE_BP)) / BP_DENOMINATOR,
  };
}

/**
 * Minimum admissible progress for a leg: max(5 km, 5% of the segment
 * distance). The leg that reaches the destination is exempt (see priceLeg) —
 * otherwise a parcel rerouted to < 5 km from its goal could never be delivered.
 */
export function minLegProgressKm(totalKm: number): number {
  if (!Number.isFinite(totalKm) || totalKm <= 0) {
    throw new EconomicsError('invalid_distance', `totalKm must be a finite km value > 0, got ${totalKm}`);
  }
  return Math.max(MIN_LEG_PROGRESS_KM, MIN_LEG_PROGRESS_RATIO * totalKm);
}

export interface PriceLegInput {
  /** Remaining WORK pool before this leg (90% denomination, ADR-014) — see
   *  remainingPool(). */
  poolMsat: Msat;
  /** Segment distance D (the shipment's frozen distance, or the remaining
   *  distance frozen at the last reroute). Needed for the 5%-of-D guard. */
  totalKm: number;
  /** Remaining distance r before this leg (current hub → destination). */
  remainingKm: number;
  /** Progress Δr produced by this leg (r_before − r_after). */
  progressKm: number;
  /** Departure hub fee, integer basis points (hubFeePercentToBp). */
  depHubFeeBp: number;
  /** Arrival hub fee, integer basis points. */
  arrHubFeeBp: number;
  /** The shipment's accrued carrier quota Π_v of the finalization bonus
   *  (Σ splitCommitment(...).carrierBonusMsat over offer and boosts), or 0n
   *  once consumed by a delivery (ADR-014). Explicit on purpose: forgetting
   *  it on a final leg would silently strip the delivery incentive. Frozen
   *  (sat-floored) onto the leg only when Δr = r. */
  carrierBonusMsat: Msat;
}

/**
 * Price one leg (ECONOMICS.md §3 Model B, on the work pool of ADR-014):
 *
 *   gross = pool × Δr / r          (floored to a whole sat)
 *   fee_dep = f_dep × gross        (floored to a whole sat)
 *   fee_arr = f_arr × gross        (floored to a whole sat)
 *   net = gross − fee_dep − fee_arr
 *   finalization bonus = Δr = r ? floorToSat(carrierBonusMsat) : 0
 *
 * The bonus is NOT part of gross: hub fees are computed on the gross only
 * (ADR-014: the bonus pays no fees) and the leg-payment hold is
 * gross + bonus.
 *
 * Guards: positive progress only, Δr ≤ r, minimum progress max(5 km, 5% D)
 * unless the leg completes the journey (Δr = r), each hub fee ≤ 30% and
 * f_dep + f_arr < 100% (defense in depth: implied by the per-hub cap today,
 * kept in case the cap is ever loosened).
 */
export function priceLeg(input: PriceLegInput): LegPricing {
  assertNonNegativeMsat(input.poolMsat, 'poolMsat');
  assertNonNegativeMsat(input.carrierBonusMsat, 'carrierBonusMsat');
  const totalM = kmToMeters(input.totalKm, 'totalKm');
  const remainingM = kmToMeters(input.remainingKm, 'remainingKm');
  const progressM = kmToMeters(input.progressKm, 'progressKm');
  if (totalM <= 0n) {
    throw new EconomicsError('invalid_distance', `totalKm must be > 0, got ${input.totalKm}`);
  }
  if (remainingM <= 0n || remainingM > totalM) {
    throw new EconomicsError(
      'invalid_distance',
      `remainingKm must be in (0, totalKm], got ${input.remainingKm} of ${input.totalKm}`,
    );
  }
  if (progressM <= 0n) {
    throw new EconomicsError('progress_below_minimum', `progressKm must be > 0, got ${input.progressKm}`);
  }
  if (progressM > remainingM) {
    // Overshooting the destination makes no sense: the drop hub either IS the
    // destination (Δr = r) or lies strictly before it (positive-progress rule).
    throw new EconomicsError(
      'progress_exceeds_remaining',
      `progressKm ${input.progressKm} exceeds remainingKm ${input.remainingKm}`,
    );
  }
  // Minimum progress max(5 km, 5% D) — expressed as integer comparisons
  // (progress × 20 ≥ D avoids any float division). Delivering to the final
  // destination is always admissible, however short the last hop is.
  const reachesDestination = progressM === remainingM;
  if (!reachesDestination && (progressM < BigInt(MIN_LEG_PROGRESS_KM * 1000) || progressM * 20n < totalM)) {
    throw new EconomicsError(
      'progress_below_minimum',
      `progressKm ${input.progressKm} is below max(${MIN_LEG_PROGRESS_KM} km, 5% of ${input.totalKm} km)`,
    );
  }
  const depBp = assertValidHubFeeBp(input.depHubFeeBp, 'depHubFeeBp');
  const arrBp = assertValidHubFeeBp(input.arrHubFeeBp, 'arrHubFeeBp');
  if (depBp + arrBp >= BP_DENOMINATOR) {
    throw new EconomicsError(
      'invalid_hub_fee',
      `depHubFeeBp + arrHubFeeBp must stay below 100%, got ${input.depHubFeeBp} + ${input.arrHubFeeBp}`,
    );
  }

  const grossMsat = floorToSat((input.poolMsat * progressM) / remainingM);
  const depHubFeeMsat = floorToSat((grossMsat * depBp) / BP_DENOMINATOR);
  const arrHubFeeMsat = floorToSat((grossMsat * arrBp) / BP_DENOMINATOR);
  // Never negative: dep + arr < 100% of gross by the guard above, and the fee
  // floors only shrink what the carrier hands over.
  const netMsat = grossMsat - depHubFeeMsat - arrHubFeeMsat;
  // Only the leg that reaches the destination earns the carrier quota; the
  // sub-sat remainder of the freeze stays with the sender (ADR-014 §7).
  const finalizationBonusMsat = reachesDestination ? floorToSat(input.carrierBonusMsat) : 0n;
  return { grossMsat, depHubFeeMsat, arrHubFeeMsat, netMsat, finalizationBonusMsat };
}

/**
 * Notional remaining WORK pool at distance r from the destination, within one
 * segment (ECONOMICS.md §5, denominated per ADR-014):
 *
 *   pool(r) = W × r / D + Σᵢ ΔWᵢ × r / r_bᵢ
 *
 * where W and ΔWᵢ are the WORK parts (splitCommitment(...).workMsat) of the
 * segment commitment and of each boost — the 10% finalization bonus never
 * enters the pool. Each boost joined the pool when the parcel was r_bᵢ km
 * away and is consumed proportionally from there on — a constant contribution
 * would let a split journey pay out more than the committed work pool,
 * breaking conservation. The formula depends only on the current r, not on
 * how past legs were split: anyone can recompute the pool from the shipment
 * row plus its boost events.
 *
 * Each term is truncated at msat precision; sub-msat remainders stay with the
 * sender. The result is notional accounting (nothing is prefunded, ADR-013):
 * actual money moves only through priceLeg amounts.
 */
export function remainingPool(
  offerMsat: Msat,
  totalKm: number,
  remainingKm: number,
  boosts: readonly PoolBoost[] = [],
): Msat {
  assertNonNegativeMsat(offerMsat, 'offerMsat');
  const totalM = kmToMeters(totalKm, 'totalKm');
  const remainingM = kmToMeters(remainingKm, 'remainingKm');
  if (totalM <= 0n) {
    throw new EconomicsError('invalid_distance', `totalKm must be > 0, got ${totalKm}`);
  }
  if (remainingM > totalM) {
    throw new EconomicsError(
      'invalid_distance',
      `remainingKm must be <= totalKm, got ${remainingKm} of ${totalKm}`,
    );
  }
  let pool = (offerMsat * remainingM) / totalM;
  for (const boost of boosts) {
    if (boost.amountMsat <= 0n) {
      throw new EconomicsError('invalid_boost', `boost amount must be > 0 msat, got ${boost.amountMsat}`);
    }
    const atM = kmToMeters(boost.atRemainingKm, 'boost.atRemainingKm');
    if (atM <= 0n || atM > totalM) {
      throw new EconomicsError(
        'invalid_boost',
        `boost.atRemainingKm must be in (0, totalKm], got ${boost.atRemainingKm} of ${totalKm}`,
      );
    }
    if (atM < remainingM) {
      // A boost happens while the parcel sits at some hub; it cannot lie
      // closer to the destination than the parcel currently is.
      throw new EconomicsError(
        'invalid_boost',
        `boost.atRemainingKm ${boost.atRemainingKm} lies ahead of remainingKm ${remainingKm}`,
      );
    }
    pool += (boost.amountMsat * remainingM) / atM;
  }
  return pool;
}

/**
 * Reroute at a standstill (ECONOMICS.md §5): the current pool — boosts
 * included — is frozen as the commitment of a fresh segment spread over the
 * new remaining distance. Already-paid legs are untouched by construction:
 * they were priced against the pool as it stood then. Later boosts must be
 * expressed relative to the new segment (their atRemainingKm ≤ newRemainingKm).
 */
export function applyReroute(
  offerMsat: Msat,
  totalKm: number,
  remainingKm: number,
  newRemainingKm: number,
  boosts: readonly PoolBoost[] = [],
): PoolSegment {
  const newM = kmToMeters(newRemainingKm, 'newRemainingKm');
  if (newM <= 0n) {
    throw new EconomicsError('invalid_distance', `newRemainingKm must be > 0, got ${newRemainingKm}`);
  }
  return {
    offerMsat: remainingPool(offerMsat, totalKm, remainingKm, boosts),
    totalKm: newRemainingKm,
  };
}

/**
 * Compensation owed to the origin hub when the sender cancels after check-in
 * with no leg ever departed: f_o × the segment's WORK commitment — what the
 * hub would have earned from a single-leg journey, which under ADR-014 is
 * priced on the work pool (the finalization bonus is excluded from every
 * other formula, this one included). Paid directly sender → hub; the parcel
 * is released back on payment.
 */
export function cancellationCompensation(workCommitmentMsat: Msat, originHubFeeBp: number): Msat {
  assertNonNegativeMsat(workCommitmentMsat, 'workCommitmentMsat');
  const feeBp = assertValidHubFeeBp(originHubFeeBp, 'originHubFeeBp');
  return floorToSat((workCommitmentMsat * feeBp) / BP_DENOMINATOR);
}
