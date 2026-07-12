// Suggested-rate fixtures (MATCHING.md §4–5). Observations use the fixture
// rate 1 EUR = 1_000_000 msat unless a test exercises per-observation rates.

import { describe, expect, it } from 'vitest';
import type { CarrierRateObservation, DeliveredShipmentObservation } from './rates';
import { suggestCarrierRateEurPerKm, suggestSenderOfferEur } from './rates';

const NOW = new Date('2026-07-12T12:00:00Z');
const MSAT_PER_EUR = 1_000_000n;
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

/** A completed leg accepted at `rateEurPerKm` over a 10 km detour. */
function carrierObs(rateEurPerKm: number, acceptedAt: Date = daysAgo(1)): CarrierRateObservation {
  return {
    netMsat: BigInt(Math.round(rateEurPerKm * 10 * 1_000_000)),
    detourKm: 10,
    msatPerEur: MSAT_PER_EUR,
    acceptedAt,
  };
}

/** A delivered shipment priced at `rateEurPerKm` over a 100 km route. */
function senderObs(
  rateEurPerKm: number,
  deliveredAt: Date = daysAgo(1),
): DeliveredShipmentObservation {
  return {
    offerMsat: BigInt(Math.round(rateEurPerKm * 100 * 1_000_000)),
    totalKm: 100,
    msatPerEur: MSAT_PER_EUR,
    deliveredAt,
  };
}

describe('suggestCarrierRateEurPerKm (MATCHING.md §4)', () => {
  it('returns the 0.20 €/km cold-start default below 30 observations', () => {
    expect(suggestCarrierRateEurPerKm([], NOW)).toBe(0.2);
    const twentyNine = Array.from({ length: 29 }, () => carrierObs(0.5));
    expect(suggestCarrierRateEurPerKm(twentyNine, NOW)).toBe(0.2);
  });

  it('returns p25 of the effective rates with enough observations', () => {
    // Rates 0.10, 0.11, …, 0.49 (40 samples): p25 by linear interpolation
    // sits at index 9.75 → 0.19 + 0.75 × 0.01 = 0.1975 €/km.
    const observations = Array.from({ length: 40 }, (_, i) => carrierObs(0.1 + i * 0.01));
    expect(suggestCarrierRateEurPerKm(observations, NOW)).toBeCloseTo(0.1975, 10);
  });

  it('converts each observation at its own frozen exchange rate', () => {
    // Same 3.00 € net over 10 km, but half the observations were frozen when
    // 1 EUR bought twice the msat: their effective rate is 0.15 €/km, not 0.30.
    const cheapSats = Array.from({ length: 15 }, () => ({
      ...carrierObs(0.3),
      msatPerEur: 2_000_000n,
    }));
    const observations = [...Array.from({ length: 15 }, () => carrierObs(0.3)), ...cheapSats];
    // Sample = 15×0.30 and 15×0.15 → p25 = 0.15 (linear interpolation stays
    // inside the lower block: index 7.25 of the sorted 30).
    expect(suggestCarrierRateEurPerKm(observations, NOW)).toBeCloseTo(0.15, 10);
  });

  it('ignores observations outside the 90-day window', () => {
    const stale = Array.from({ length: 40 }, () => carrierObs(0.9, daysAgo(91)));
    expect(suggestCarrierRateEurPerKm(stale, NOW)).toBe(0.2);
    // 29 recent + many stale: still below the 30-observation bar.
    const mixed = [...Array.from({ length: 29 }, () => carrierObs(0.9)), ...stale];
    expect(suggestCarrierRateEurPerKm(mixed, NOW)).toBe(0.2);
  });

  it('discards detours below 1 km (the ratio explodes)', () => {
    const micro = Array.from({ length: 40 }, () => ({ ...carrierObs(0.5), detourKm: 0.5 }));
    expect(suggestCarrierRateEurPerKm(micro, NOW)).toBe(0.2);
  });

  it('clamps the result to [0.05, 1.00] €/km', () => {
    const dumping = Array.from({ length: 40 }, () => carrierObs(0.01));
    expect(suggestCarrierRateEurPerKm(dumping, NOW)).toBe(0.05);
    const gouging = Array.from({ length: 40 }, () => carrierObs(5));
    expect(suggestCarrierRateEurPerKm(gouging, NOW)).toBe(1);
  });
});

describe('suggestSenderOfferEur (MATCHING.md §5)', () => {
  it('cold start: D × 0.05 €/km — the canonical 5 € for 100 km', () => {
    expect(suggestSenderOfferEur(100, [], NOW)).toBe(5);
  });

  it('never suggests below 2 €, whatever the distance', () => {
    expect(suggestSenderOfferEur(10, [], NOW)).toBe(2);
    const cheap = Array.from({ length: 40 }, () => senderObs(0.01));
    expect(suggestSenderOfferEur(50, cheap, NOW)).toBe(2);
  });

  it('returns D × p50 of delivered P/D with enough observations', () => {
    // Rates 0.02, 0.04, …, 0.62 (31 samples): the median is 0.32 €/km.
    const observations = Array.from({ length: 31 }, (_, i) => senderObs(0.02 + i * 0.02));
    expect(suggestSenderOfferEur(100, observations, NOW)).toBeCloseTo(32, 8);
  });

  it('ignores deliveries outside the 90-day window', () => {
    const stale = Array.from({ length: 40 }, () => senderObs(0.5, daysAgo(120)));
    expect(suggestSenderOfferEur(100, stale, NOW)).toBe(5);
  });

  it('rejects a non-positive route distance', () => {
    expect(() => suggestSenderOfferEur(0, [], NOW)).toThrow(RangeError);
    expect(() => suggestSenderOfferEur(Number.NaN, [], NOW)).toThrow(RangeError);
  });
});
