// Exact-to-the-msat fixtures for the three simulations of ECONOMICS.md §4,
// plus unit tests for every guard. EUR amounts in the doc map to msat at the
// fixture rate 1 EUR = 1000 sats = 1_000_000 msat (frozen at creation,
// ADR-008), so the canonical 5.00 € offer is P = 5_000_000 msat.

import { describe, expect, it } from 'vitest';
import {
  EconomicsError,
  applyReroute,
  cancellationCompensation,
  floorToSat,
  minLegProgressKm,
  priceLeg,
  remainingPool,
} from './economics';

const P = 5_000_000n; // 5.00 € at the fixture rate
const D = 100; // km

describe('ECONOMICS.md §4 — case 1: single leg A→B, hubs at 10%', () => {
  it('the full-route carrier grosses the whole pool and nets 80%', () => {
    const pool = remainingPool(P, D, 100);
    expect(pool).toBe(5_000_000n);
    expect(
      priceLeg({
        poolMsat: pool,
        totalKm: D,
        remainingKm: 100,
        progressKm: 100,
        depHubFeeBp: 1000,
        arrHubFeeBp: 1000,
      }),
    ).toEqual({
      grossMsat: 5_000_000n, // 5.00 € × 100/100
      depHubFeeMsat: 500_000n, // 0.50 €
      arrHubFeeMsat: 500_000n, // 0.50 €
      netMsat: 4_000_000n, // 4.00 € — 80% of the offer
    });
  });
});

describe('ECONOMICS.md §4 — case 2: canonical two legs (A→C 40 km, C→B 60 km, hubs at 10%)', () => {
  it('leg 1 — Luca: gross 2.00 €, both hubs 0.20 €, net 1.60 €', () => {
    expect(
      priceLeg({
        poolMsat: remainingPool(P, D, 100),
        totalKm: D,
        remainingKm: 100,
        progressKm: 40,
        depHubFeeBp: 1000,
        arrHubFeeBp: 1000,
      }),
    ).toEqual({
      grossMsat: 2_000_000n,
      depHubFeeMsat: 200_000n,
      arrHubFeeMsat: 200_000n,
      netMsat: 1_600_000n,
    });
  });

  it('leg 2 — remaining pool 3.00 €, gross 3.00 €, net 2.40 €; totals conserve P', () => {
    const pool = remainingPool(P, D, 60);
    expect(pool).toBe(3_000_000n);
    const leg2 = priceLeg({
      poolMsat: pool,
      totalKm: D,
      remainingKm: 60,
      progressKm: 60,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
    });
    expect(leg2).toEqual({
      grossMsat: 3_000_000n,
      depHubFeeMsat: 300_000n,
      arrHubFeeMsat: 300_000n,
      netMsat: 2_400_000n,
    });
    // Doc totals: gross sum = P (exact conservation), hub C earns 0.50 € across
    // the two adjacent legs, net €/km uniform at 0.040 €/km for both carriers.
    expect(2_000_000n + leg2.grossMsat).toBe(P);
    expect(200_000n + leg2.depHubFeeMsat).toBe(500_000n);
    expect(1_600_000n / 40n).toBe(leg2.netMsat / 60n); // 40_000 msat/km each
  });
});

describe('ECONOMICS.md §4 — case 3: three legs 30+40+30 km, hubs origin/dest 10%, H1 10%, H2 20%', () => {
  it('freezes exactly the amounts of the doc table', () => {
    const leg1 = priceLeg({
      poolMsat: remainingPool(P, D, 100),
      totalKm: D,
      remainingKm: 100,
      progressKm: 30,
      depHubFeeBp: 1000, // origin 10%
      arrHubFeeBp: 1000, // H1 10%
    });
    expect(leg1).toEqual({
      grossMsat: 1_500_000n,
      depHubFeeMsat: 150_000n,
      arrHubFeeMsat: 150_000n,
      netMsat: 1_200_000n,
    });

    const pool2 = remainingPool(P, D, 70);
    expect(pool2).toBe(3_500_000n);
    const leg2 = priceLeg({
      poolMsat: pool2,
      totalKm: D,
      remainingKm: 70,
      progressKm: 40,
      depHubFeeBp: 1000, // H1 10%
      arrHubFeeBp: 2000, // H2 20%
    });
    expect(leg2).toEqual({
      grossMsat: 2_000_000n,
      depHubFeeMsat: 200_000n,
      arrHubFeeMsat: 400_000n,
      netMsat: 1_400_000n,
    });

    const pool3 = remainingPool(P, D, 30);
    expect(pool3).toBe(1_500_000n);
    const leg3 = priceLeg({
      poolMsat: pool3,
      totalKm: D,
      remainingKm: 30,
      progressKm: 30,
      depHubFeeBp: 2000, // H2 20%
      arrHubFeeBp: 1000, // destination 10%
    });
    expect(leg3).toEqual({
      grossMsat: 1_500_000n,
      depHubFeeMsat: 300_000n,
      arrHubFeeMsat: 150_000n,
      netMsat: 1_050_000n,
    });

    // Doc totals row: gross Σ = 5.00 €, hubs Σ = 1.35 €, carriers Σ = 3.65 €.
    expect(leg1.grossMsat + leg2.grossMsat + leg3.grossMsat).toBe(P);
    const hubTotal =
      leg1.depHubFeeMsat +
      leg1.arrHubFeeMsat +
      leg2.depHubFeeMsat +
      leg2.arrHubFeeMsat +
      leg3.depHubFeeMsat +
      leg3.arrHubFeeMsat;
    expect(hubTotal).toBe(1_350_000n);
    expect(leg1.netMsat + leg2.netMsat + leg3.netMsat).toBe(3_650_000n);
  });
});

describe('boost (ECONOMICS.md §5)', () => {
  it('joins the pool at boost time: pool = P × r/D + ΔP', () => {
    // 1.00 € boost while the parcel sits 50 km from destination.
    expect(remainingPool(P, D, 50, [{ amountMsat: 1_000_000n, atRemainingKm: 50 }])).toBe(3_500_000n);
  });

  it('decays proportionally afterwards: contribution ΔP × r / r_b', () => {
    // Halfway from the boost point the boost contributes 0.50 €, not 1.00 € —
    // a constant contribution would let split journeys pay out more than P+ΔP.
    expect(remainingPool(P, D, 25, [{ amountMsat: 1_000_000n, atRemainingKm: 50 }])).toBe(
      1_250_000n + 500_000n,
    );
  });

  it('rejects boosts lying ahead of the parcel or non-positive', () => {
    expect(() => remainingPool(P, D, 60, [{ amountMsat: 1_000n, atRemainingKm: 50 }])).toThrow(
      EconomicsError,
    );
    expect(() => remainingPool(P, D, 50, [{ amountMsat: 0n, atRemainingKm: 50 }])).toThrow(
      EconomicsError,
    );
    expect(() => remainingPool(P, D, 50, [{ amountMsat: 1_000n, atRemainingKm: 101 }])).toThrow(
      EconomicsError,
    );
  });
});

describe('reroute (ECONOMICS.md §5)', () => {
  it('freezes the current pool as a fresh segment over the new distance', () => {
    // Parcel 60 km from B with pool 3.00 €; sender reroutes to a hub 80 km away.
    const segment = applyReroute(P, D, 60, 80);
    expect(segment).toEqual({ offerMsat: 3_000_000n, totalKm: 80 });
    // Paid legs are untouched: only future pricing uses the new segment.
    expect(remainingPool(segment.offerMsat, segment.totalKm, 40)).toBe(1_500_000n);
  });

  it('carries boosts into the frozen commitment', () => {
    const segment = applyReroute(P, D, 50, 30, [{ amountMsat: 1_000_000n, atRemainingKm: 50 }]);
    expect(segment).toEqual({ offerMsat: 3_500_000n, totalKm: 30 });
  });

  it('supports the delivered-then-reroute case (pool exhausted, boost required)', () => {
    const segment = applyReroute(P, D, 0, 20);
    expect(segment.offerMsat).toBe(0n);
    const pool = remainingPool(segment.offerMsat, segment.totalKm, 20, [
      { amountMsat: 2_000_000n, atRemainingKm: 20 },
    ]);
    expect(pool).toBe(2_000_000n);
  });

  it('rejects a non-positive new distance', () => {
    expect(() => applyReroute(P, D, 60, 0)).toThrow(EconomicsError);
  });
});

describe('cancellation compensation (f_o × P)', () => {
  it('pays the origin hub what a single-leg journey would have', () => {
    expect(cancellationCompensation(P, 1000)).toBe(500_000n);
  });

  it('floors to a whole sat', () => {
    expect(cancellationCompensation(5_000_001n, 1000)).toBe(500_000n);
  });
});

describe('rounding (ADR-008: floor to the sat, remainders stay with the sender)', () => {
  it('floorToSat truncates msat to whole sats and rejects negatives', () => {
    expect(floorToSat(1_666_666n)).toBe(1_666_000n);
    expect(floorToSat(999n)).toBe(0n);
    expect(() => floorToSat(-1n)).toThrow(EconomicsError);
  });

  it('gross is floored to the sat; gross + fees + net always reconcile', () => {
    // pool × Δr/r = 5_000_000 × 10/30 = 1_666_666.6̅ msat → 1_666_000 (floor sat)
    const leg = priceLeg({
      poolMsat: P,
      totalKm: D,
      remainingKm: 30,
      progressKm: 10,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
    });
    expect(leg.grossMsat).toBe(1_666_000n);
    expect(leg.depHubFeeMsat).toBe(166_000n); // floor(166_600) to sat
    expect(leg.netMsat).toBe(1_666_000n - 2n * 166_000n);
    expect(leg.depHubFeeMsat + leg.arrHubFeeMsat + leg.netMsat).toBe(leg.grossMsat);
  });
});

describe('guards', () => {
  const base = {
    poolMsat: P,
    totalKm: D,
    remainingKm: 100,
    progressKm: 40,
    depHubFeeBp: 1000,
    arrHubFeeBp: 1000,
  };

  it('minimum progress is max(5 km, 5% D)', () => {
    expect(minLegProgressKm(100)).toBe(5);
    expect(minLegProgressKm(400)).toBe(20);
    expect(() => priceLeg({ ...base, progressKm: 4.9 })).toThrow(/below max/);
    expect(() => priceLeg({ ...base, totalKm: 400, remainingKm: 400, progressKm: 19 })).toThrow(
      /below max/,
    );
    expect(priceLeg({ ...base, progressKm: 5 }).grossMsat).toBe(250_000n);
  });

  it('the final leg to the destination is exempt from the minimum', () => {
    // Reroute left the parcel 3 km from the goal: delivering must stay possible.
    const leg = priceLeg({ ...base, remainingKm: 3, progressKm: 3 });
    expect(leg.grossMsat).toBe(P);
  });

  it('only positive progress, never beyond the destination', () => {
    expect(() => priceLeg({ ...base, progressKm: 0 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, progressKm: -10 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, remainingKm: 30, progressKm: 31 })).toThrow(
      /exceeds remainingKm/,
    );
  });

  it('rejects hub fees above the 30% cap, non-integer bp and NaN distances', () => {
    expect(() => priceLeg({ ...base, depHubFeeBp: 3001 })).toThrow(/between 0 and 3000/);
    expect(() => priceLeg({ ...base, arrHubFeeBp: 10.5 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, arrHubFeeBp: -1 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, remainingKm: Number.NaN })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, totalKm: 0 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, poolMsat: -1n })).toThrow(EconomicsError);
  });

  it('accepts both hubs at the 30% cap (sum still < 100%)', () => {
    const leg = priceLeg({ ...base, depHubFeeBp: 3000, arrHubFeeBp: 3000 });
    expect(leg.netMsat).toBe(leg.grossMsat - leg.depHubFeeMsat - leg.arrHubFeeMsat);
    expect(leg.netMsat > 0n).toBe(true);
  });

  it('remainingPool validates its distances', () => {
    expect(() => remainingPool(P, 0, 0)).toThrow(EconomicsError);
    expect(() => remainingPool(P, D, 101)).toThrow(EconomicsError);
    expect(() => remainingPool(-1n, D, 50)).toThrow(EconomicsError);
    expect(remainingPool(P, D, 0)).toBe(0n);
  });
});
