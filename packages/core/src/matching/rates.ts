// Suggested carrier rate and sender offer (MATCHING.md §4–5). Pure functions.
//
// These produce SUGGESTIONS in EUR — display-level anchors for free-form
// input fields, not money movements: nothing here touches the ledger, so
// float EUR is fine (actual amounts are frozen in bigint msat elsewhere,
// ADR-008). The asymmetry is deliberate: the carrier is anchored LOW (p25 of
// what carriers actually accepted), the sender is anchored at the price that
// historically DELIVERED (p50) — suggesting the low end to senders too would
// produce shipments nobody accepts and first-use distrust.
//
// Anti-manipulation: callers must feed only accepted-and-completed legs /
// delivered shipments (faking those costs bonds and time), and the cold-start
// default holds until MIN_RATE_OBSERVATIONS real samples exist.

import type { Msat } from '@mercurio/shared';
import {
  CARRIER_RATE_MAX_EUR_PER_KM,
  CARRIER_RATE_MIN_EUR_PER_KM,
  DEFAULT_CARRIER_RATE_EUR_PER_KM,
  DEFAULT_SENDER_RATE_EUR_PER_KM,
  MIN_OBSERVATION_DETOUR_KM,
  MIN_RATE_OBSERVATIONS,
  MIN_SUGGESTED_OFFER_EUR,
  RATE_WINDOW_DAYS,
} from '@mercurio/shared';

const WINDOW_MS = RATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Linear-interpolation percentile (numpy default) over a non-empty sample.
 *  Any fixed convention works — what matters is that it is deterministic and
 *  documented, so the suggested rate is reproducible from the observations. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const lowerValue = sorted[lower] ?? 0; // callers guarantee non-empty
  const upperValue = sorted[Math.min(lower + 1, sorted.length - 1)] ?? lowerValue;
  return lowerValue + fraction * (upperValue - lowerValue);
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** One accepted-and-completed leg (a `rate_observations` row). */
export interface CarrierRateObservation {
  /** Carrier net frozen at acceptance, msat. */
  netMsat: Msat;
  /** Detour the carrier actually accepted for that leg, km. */
  detourKm: number;
  /** The shipment's frozen exchange rate, msat per 1 EUR (ADR-008: each
   *  observation converts at ITS OWN snapshot, not today's price). */
  msatPerEur: Msat;
  acceptedAt: Date;
}

/**
 * Suggested minimum carrier rate, €/km of detour (MATCHING.md §4): p25 of the
 * effective rates (net/detour) carriers accepted in the last 90 days —
 * "media al ribasso" per spec: robust to friendship-priced outliers and
 * structurally low. Falls back to DEFAULT_CARRIER_RATE_EUR_PER_KM until
 * MIN_RATE_OBSERVATIONS samples exist; always clamped to [0.05, 1.00] €/km.
 */
export function suggestCarrierRateEurPerKm(
  observations: readonly CarrierRateObservation[],
  now: Date,
): number {
  const cutoffMs = now.getTime() - WINDOW_MS;
  const rates = observations
    .filter(
      (o) =>
        Number.isFinite(o.detourKm) &&
        o.detourKm >= MIN_OBSERVATION_DETOUR_KM &&
        o.msatPerEur > 0n &&
        o.netMsat >= 0n &&
        o.acceptedAt.getTime() >= cutoffMs &&
        o.acceptedAt.getTime() <= now.getTime(),
    )
    .map((o) => Number(o.netMsat) / Number(o.msatPerEur) / o.detourKm);
  const suggested =
    rates.length >= MIN_RATE_OBSERVATIONS
      ? percentile(rates, 0.25)
      : DEFAULT_CARRIER_RATE_EUR_PER_KM;
  return clamp(suggested, CARRIER_RATE_MIN_EUR_PER_KM, CARRIER_RATE_MAX_EUR_PER_KM);
}

/** One DELIVERED shipment — an offer that was published but never picked up
 *  is a wish, not a price (MATCHING.md §5). */
export interface DeliveredShipmentObservation {
  /** The sender's offer P, msat (boosts excluded: the doc's rate is P/D). */
  offerMsat: Msat;
  /** The route distance D frozen at creation, km. */
  totalKm: number;
  /** The shipment's frozen exchange rate, msat per 1 EUR. */
  msatPerEur: Msat;
  deliveredAt: Date;
}

/**
 * Suggested sender offer in EUR for a route of `routeKm` (MATCHING.md §5):
 * routeKm × p50 of P/D over shipments delivered in the last 90 days — the
 * median price that actually got parcels to their destination. Cold start:
 * 0.05 €/km (the canonical 5 € / 100 km example). Never below 2 €.
 */
export function suggestSenderOfferEur(
  routeKm: number,
  observations: readonly DeliveredShipmentObservation[],
  now: Date,
): number {
  if (!Number.isFinite(routeKm) || routeKm <= 0) {
    throw new RangeError(`routeKm must be a finite km value > 0, got ${routeKm}`);
  }
  const cutoffMs = now.getTime() - WINDOW_MS;
  const rates = observations
    .filter(
      (o) =>
        Number.isFinite(o.totalKm) &&
        o.totalKm > 0 &&
        o.msatPerEur > 0n &&
        o.offerMsat >= 0n &&
        o.deliveredAt.getTime() >= cutoffMs &&
        o.deliveredAt.getTime() <= now.getTime(),
    )
    .map((o) => Number(o.offerMsat) / Number(o.msatPerEur) / o.totalKm);
  const ratePerKm =
    rates.length >= MIN_RATE_OBSERVATIONS ? percentile(rates, 0.5) : DEFAULT_SENDER_RATE_EUR_PER_KM;
  return Math.max(routeKm * ratePerKm, MIN_SUGGESTED_OFFER_EUR);
}
