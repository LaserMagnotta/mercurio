// Economics types shared between @mercurio/core (the pricing engine) and the
// API (which freezes these amounts on `legs` rows and exposes them over REST).
// The math itself lives in @mercurio/core/economics — pure functions only.

import type { Msat } from './index';

/**
 * The four amounts frozen on a leg at acceptance time (ECONOMICS.md, ADR-006).
 * Invariant: grossMsat = depHubFeeMsat + arrHubFeeMsat + netMsat, all floored
 * to a whole sat (ADR-008: invoices are denominated in sats).
 */
export interface LegPricing {
  /** What the sender pays the carrier for this leg (hold invoice amount). */
  grossMsat: Msat;
  /** Departure-hub cut, paid on the spot by the carrier at pickup. */
  depHubFeeMsat: Msat;
  /** Arrival-hub cut, paid on the spot by the carrier at check-in. */
  arrHubFeeMsat: Msat;
  /** What the carrier keeps: gross − both hub fees. Shown on the board. */
  netMsat: Msat;
}

/**
 * A sender top-up while the parcel is idle (ECONOMICS.md §5).
 * `atRemainingKm` is the remaining distance when the boost happened: the boost
 * joins the pool at that point and is consumed proportionally afterwards
 * (pool contribution at distance r ≤ atRemainingKm is amount × r / atRemainingKm).
 * A constant contribution would let a journey pay out more than P + ΔP when
 * split into several legs, breaking pool conservation.
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
  /** Spending commitment at segment start (the offer P for the first segment). */
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
