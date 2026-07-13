// Economics types shared between @mercurio/core (the pricing engine) and the
// API (which freezes these amounts on `legs` rows and exposes them over REST).
// The math itself lives in @mercurio/core/economics — pure functions only.

import type { Msat } from './index';

/**
 * The five amounts frozen on a leg at acceptance time (ECONOMICS.md, ADR-006,
 * ADR-014). Invariant: grossMsat = depHubFeeMsat + arrHubFeeMsat + netMsat,
 * all floored to a whole sat (ADR-008: invoices are denominated in sats).
 * The finalization bonus sits OUTSIDE that identity: hub fees never touch it
 * (ADR-014), and the leg-payment hold is grossMsat + finalizationBonusMsat.
 */
export interface LegPricing {
  /** The leg's share of the WORK pool (90% of the commitment, ADR-014). */
  grossMsat: Msat;
  /** Departure-hub cut, paid on the spot by the carrier at pickup. */
  depHubFeeMsat: Msat;
  /** Arrival-hub cut, paid on the spot by the carrier at check-in. */
  arrHubFeeMsat: Msat;
  /** What the carrier keeps of the gross: gross − both hub fees. */
  netMsat: Msat;
  /** Carrier share Π_v of the finalization bonus (ADR-014), rides inside the
   *  leg-payment hold. Zero unless this leg delivers to the destination hub
   *  (and zero there too once the share was consumed by an earlier arrival). */
  finalizationBonusMsat: Msat;
}

/**
 * The two amounts frozen on a recipient claim at request time (ADR-016,
 * ECONOMICS.md §5-ter). The claim payment is the remaining work pool plus the
 * accrued unconsumed carrier bonus share Π_v (the recipient does the residual
 * carriage themselves); the hub bonus is the accrued Π_h for the hub where
 * the pickup happens. Each part is floored to a whole sat independently, like
 * leg pricing; the claim pays no hub fees (the pickup hub was already paid
 * the arrival fee of its incoming leg, and the delivery work is paid by Π_h).
 */
export interface ClaimPricing {
  /** Hold sender → recipient: floorToSat(pool) + floorToSat(Π_v). */
  claimPaymentMsat: Msat;
  /** Hold sender → pickup-hub owner: floorToSat(Π_h); 0 ⇒ no hold at all. */
  hubBonusMsat: Msat;
}

/**
 * A sender top-up while the parcel is idle (ECONOMICS.md §5).
 * `amountMsat` is the boost's WORK-pool share — splitCommitment(ΔP).workMsat,
 * the 90% left after the finalization-bonus carve-out (ADR-014); the bonus
 * shares accrue to the shipment's bonus quotas, never to the pool.
 * `atRemainingKm` is the remaining distance when the boost happened: the boost
 * joins the pool at that point and is consumed proportionally afterwards
 * (pool contribution at distance r ≤ atRemainingKm is amount × r / atRemainingKm).
 * A constant contribution would let a journey pay out more than the committed
 * work pool when split into several legs, breaking pool conservation.
 */
export interface PoolBoost {
  amountMsat: Msat;
  atRemainingKm: number;
}

/**
 * The pool parameters between reroutes. A reroute freezes the current pool as
 * the new commitment and spreads it over the new remaining distance; boosts
 * are always relative to the current segment (ECONOMICS.md §5).
 */
export interface PoolSegment {
  /** Work-pool commitment at segment start: splitCommitment(P).workMsat for
   *  the first segment, the frozen pool itself after a reroute (a reroute
   *  never carves a second bonus out of it — ADR-014). */
  offerMsat: Msat;
  /** Route distance at segment start (D for the first segment), in km. */
  totalKm: number;
}

/** 1 sat = 1000 msat (Lightning's native sub-unit, ADR-008). */
export const MSAT_PER_SAT = 1000n;

/** Hub fee percentages are handled as integer basis points: 1 bp = 0.01%,
 *  matching the DB column `hubs.fee_percent numeric(5,2)` losslessly. */
export const HUB_FEE_BP_DENOMINATOR = 10_000;

/** Validation cap on a single hub's fee (ECONOMICS.md, regole di contorno):
 *  above ~30% a hub is never competitive and only pollutes the board. */
export const MAX_HUB_FEE_BP = 3_000;

/** Minimum per-leg progress: max(5 km, 5% of D). Micro-legs multiply physical
 *  handoffs (each one is a custody risk) without meaningful progress. The final
 *  leg to the destination is exempt: completing the journey is always allowed. */
export const MIN_LEG_PROGRESS_KM = 5;
export const MIN_LEG_PROGRESS_RATIO = 0.05;

/** Share of every sender commitment (offer P and each boost ΔP) carved out as
 *  the finalization bonus Π (ADR-014). Everything else — progress-based
 *  grosses, hub fees, cancellation compensation — is computed on the WORK
 *  pool, the remaining 90%; the bonus is excluded from every other formula,
 *  in both directions. */
export const FINALIZATION_BONUS_BP = 1000;

/** Split of the bonus Π: 70% to the carrier who delivers to the destination
 *  hub (inside the final leg-payment hold), 30% to the destination hub
 *  (a dedicated hold released at recipient_pickup). Each share is consumed at
 *  most once per shipment (ADR-014). */
export const FINALIZATION_CARRIER_SHARE_BP = 7000;
export const FINALIZATION_HUB_SHARE_BP = 3000;

/**
 * Convert a hub fee percentage — as stored in `hubs.fee_percent numeric(5,2)`,
 * so either a string like '12.50' or a number like 12.5 — to integer basis
 * points. Parses via string to avoid float artifacts; rejects more than two
 * decimals rather than silently rounding a configured fee.
 */
export function hubFeePercentToBp(feePercent: string | number): number {
  const text =
    typeof feePercent === 'number'
      ? Number.isFinite(feePercent)
        ? String(feePercent)
        : 'not-a-number'
      : feePercent.trim();
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new RangeError(`invalid hub fee percent: ${JSON.stringify(feePercent)}`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0') || '0');
  const bp = whole * 100 + fraction;
  if (bp > HUB_FEE_BP_DENOMINATOR) {
    throw new RangeError(`hub fee percent above 100%: ${text}`);
  }
  return bp;
}
