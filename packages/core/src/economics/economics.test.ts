// Exact-to-the-msat fixtures for the simulations of ECONOMICS.md §4 and the
// finalization-bonus example of ECONOMICS.md §5-bis / ADR-014, plus unit
// tests for every guard. EUR amounts in the docs map to msat at the fixture
// rate 1 EUR = 1000 sats = 1_000_000 msat (frozen at creation, ADR-008), so
// the canonical 5.00 € offer is P = 5_000_000 msat.
//
// Denominations (ADR-014): the sender's commitment P splits once into the
// WORK pool (90%) and the two finalization-bonus quotas (7% carrier, 3% hub).
// The §4 tables illustrate how a given pool is split across legs — here they
// are fed the work pool directly; the §5-bis fixtures run the whole chain
// from the raw commitment.

import { describe, expect, it } from 'vitest';
import {
  EconomicsError,
  applyReroute,
  cancellationCompensation,
  estimateHubFeeRange,
  floorToSat,
  minLegProgressKm,
  priceClaim,
  priceLeg,
  remainingPool,
  splitCommitment,
} from './economics.js';

const P = 5_000_000n; // the 5.00 € commitment of the canonical example
const D = 100; // km

// splitCommitment(P): work pool 4.50 €, carrier quota 0.35 €, hub quota 0.15 €.
const WORK = 4_500_000n;
const CARRIER_QUOTA = 350_000n;
const HUB_QUOTA = 150_000n;

describe('ADR-014 — splitCommitment (work pool 90%, bonus quotas 7% / 3%)', () => {
  it('splits the canonical 5.00 € commitment exactly', () => {
    expect(splitCommitment(P)).toEqual({
      workMsat: WORK,
      carrierBonusMsat: CARRIER_QUOTA,
      hubBonusMsat: HUB_QUOTA,
    });
  });

  it('truncates each part independently; the remainder (< 4 msat) stays with the sender', () => {
    // 9999 msat: work = floor(8999.1) = 8999, bonus = floor(999.9) = 999,
    // carrier = floor(699.3) = 699, hub = floor(299.7) = 299 → 2 msat remain.
    const split = splitCommitment(9_999n);
    expect(split).toEqual({ workMsat: 8_999n, carrierBonusMsat: 699n, hubBonusMsat: 299n });
    expect(split.workMsat + split.carrierBonusMsat + split.hubBonusMsat).toBe(9_997n);
  });

  it('never overstates any share (parts only floor)', () => {
    for (const amount of [1n, 9n, 10n, 999n, 1_000n, 123_456_789n]) {
      const split = splitCommitment(amount);
      expect(split.workMsat * 10_000n <= amount * 9_000n).toBe(true);
      expect((split.carrierBonusMsat + split.hubBonusMsat) * 10_000n <= amount * 1_000n).toBe(true);
      expect(split.workMsat + split.carrierBonusMsat + split.hubBonusMsat <= amount).toBe(true);
    }
  });

  it('rejects negative commitments and accepts zero', () => {
    expect(() => splitCommitment(-1n)).toThrow(EconomicsError);
    expect(splitCommitment(0n)).toEqual({ workMsat: 0n, carrierBonusMsat: 0n, hubBonusMsat: 0n });
  });
});

describe('ECONOMICS.md §5-bis / ADR-014 — canonical example (P = 5.00 €, D = 100 km, hubs at 10%)', () => {
  it('single final leg: net 3.60 € + bonus 0.35 € = 3.95 € (79%); destination hub 0.45 + 0.15 €', () => {
    const leg = priceLeg({
      poolMsat: remainingPool(WORK, D, 100),
      totalKm: D,
      remainingKm: 100,
      progressKm: 100,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: CARRIER_QUOTA,
    });
    expect(leg).toEqual({
      grossMsat: 4_500_000n, // the whole work pool
      depHubFeeMsat: 450_000n,
      arrHubFeeMsat: 450_000n,
      netMsat: 3_600_000n,
      finalizationBonusMsat: 350_000n,
    });
    expect(leg.netMsat + leg.finalizationBonusMsat).toBe(3_950_000n); // 3.95 €
    expect(leg.arrHubFeeMsat + HUB_QUOTA).toBe(600_000n); // destination hub, 0.60 €
  });

  it('two legs (Luca 40 km, final carrier 60 km): the doc table to the msat', () => {
    // Luca: gross 1.80 €, net 1.44 €. His leg does not reach the destination,
    // so the carrier quota — though accrued — is NOT frozen on it.
    const leg1 = priceLeg({
      poolMsat: remainingPool(WORK, D, 100),
      totalKm: D,
      remainingKm: 100,
      progressKm: 40,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: CARRIER_QUOTA,
    });
    expect(leg1).toEqual({
      grossMsat: 1_800_000n,
      depHubFeeMsat: 180_000n,
      arrHubFeeMsat: 180_000n,
      netMsat: 1_440_000n,
      finalizationBonusMsat: 0n,
    });

    // Final carrier: gross 2.70 €, net 2.16 € + bonus 0.35 € = 2.51 €.
    const pool2 = remainingPool(WORK, D, 60);
    expect(pool2).toBe(2_700_000n);
    const leg2 = priceLeg({
      poolMsat: pool2,
      totalKm: D,
      remainingKm: 60,
      progressKm: 60,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: CARRIER_QUOTA,
    });
    expect(leg2).toEqual({
      grossMsat: 2_700_000n,
      depHubFeeMsat: 270_000n,
      arrHubFeeMsat: 270_000n,
      netMsat: 2_160_000n,
      finalizationBonusMsat: 350_000n,
    });
    expect(leg2.netMsat + leg2.finalizationBonusMsat).toBe(2_510_000n);

    // Doc totals: hub C 0.18 + 0.27 = 0.45 €; origin hub 0.18 €; destination
    // hub 0.27 + 0.15 = 0.42 €; everything the sender committed adds up to P.
    expect(leg1.arrHubFeeMsat + leg2.depHubFeeMsat).toBe(450_000n);
    expect(leg1.depHubFeeMsat).toBe(180_000n);
    expect(leg2.arrHubFeeMsat + HUB_QUOTA).toBe(420_000n);
    expect(leg1.grossMsat + leg2.grossMsat + CARRIER_QUOTA + HUB_QUOTA).toBe(P);
  });

  it('hub fees never touch the bonus: same fees with or without the carrier quota', () => {
    const base = {
      poolMsat: WORK,
      totalKm: D,
      remainingKm: 100,
      progressKm: 100,
      depHubFeeBp: 3000,
      arrHubFeeBp: 3000,
    };
    const withBonus = priceLeg({ ...base, carrierBonusMsat: CARRIER_QUOTA });
    const without = priceLeg({ ...base, carrierBonusMsat: 0n });
    expect(withBonus.depHubFeeMsat).toBe(without.depHubFeeMsat);
    expect(withBonus.arrHubFeeMsat).toBe(without.arrHubFeeMsat);
    expect(withBonus.netMsat).toBe(without.netMsat);
    expect(withBonus.finalizationBonusMsat).toBe(350_000n);
    expect(without.finalizationBonusMsat).toBe(0n);
  });

  it('a consumed carrier quota prices the final leg with no bonus (post-arrival reroute)', () => {
    const leg = priceLeg({
      poolMsat: 1_000_000n,
      totalKm: 20,
      remainingKm: 20,
      progressKm: 20,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: 0n, // consumed by the first delivery (ADR-014 §5)
    });
    expect(leg.finalizationBonusMsat).toBe(0n);
  });
});

describe('ECONOMICS.md §4 — case 1: single leg A→B, hubs at 10% (pool fed directly)', () => {
  it('the full-route carrier grosses the whole pool and nets 80% of it', () => {
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
        carrierBonusMsat: 0n,
      }),
    ).toEqual({
      grossMsat: 5_000_000n, // pool × 100/100
      depHubFeeMsat: 500_000n,
      arrHubFeeMsat: 500_000n,
      netMsat: 4_000_000n, // 80% of the pool
      finalizationBonusMsat: 0n,
    });
  });
});

describe('ECONOMICS.md §4 — case 2: two legs 40 + 60 km, hubs at 10% (pool fed directly)', () => {
  it('leg 1: gross 40% of the pool, both hubs take 10% of it', () => {
    expect(
      priceLeg({
        poolMsat: remainingPool(P, D, 100),
        totalKm: D,
        remainingKm: 100,
        progressKm: 40,
        depHubFeeBp: 1000,
        arrHubFeeBp: 1000,
        carrierBonusMsat: 0n,
      }),
    ).toEqual({
      grossMsat: 2_000_000n,
      depHubFeeMsat: 200_000n,
      arrHubFeeMsat: 200_000n,
      netMsat: 1_600_000n,
      finalizationBonusMsat: 0n,
    });
  });

  it('leg 2: remaining pool 60%, totals conserve the pool, €/km uniform', () => {
    const pool = remainingPool(P, D, 60);
    expect(pool).toBe(3_000_000n);
    const leg2 = priceLeg({
      poolMsat: pool,
      totalKm: D,
      remainingKm: 60,
      progressKm: 60,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: 0n,
    });
    expect(leg2).toEqual({
      grossMsat: 3_000_000n,
      depHubFeeMsat: 300_000n,
      arrHubFeeMsat: 300_000n,
      netMsat: 2_400_000n,
      finalizationBonusMsat: 0n,
    });
    // Gross sum = pool (exact conservation), hub C earns 10% of both adjacent
    // legs, net €/km uniform for both carriers.
    expect(2_000_000n + leg2.grossMsat).toBe(P);
    expect(200_000n + leg2.depHubFeeMsat).toBe(500_000n);
    expect(1_600_000n / 40n).toBe(leg2.netMsat / 60n); // 40_000 msat/km each
  });
});

describe('ECONOMICS.md §4 — case 3: three legs 30+40+30 km, hubs origin/dest 10%, H1 10%, H2 20%', () => {
  it('freezes exactly the amounts of the doc table (pool fed directly)', () => {
    const leg1 = priceLeg({
      poolMsat: remainingPool(P, D, 100),
      totalKm: D,
      remainingKm: 100,
      progressKm: 30,
      depHubFeeBp: 1000, // origin 10%
      arrHubFeeBp: 1000, // H1 10%
      carrierBonusMsat: 0n,
    });
    expect(leg1).toEqual({
      grossMsat: 1_500_000n,
      depHubFeeMsat: 150_000n,
      arrHubFeeMsat: 150_000n,
      netMsat: 1_200_000n,
      finalizationBonusMsat: 0n,
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
      carrierBonusMsat: 0n,
    });
    expect(leg2).toEqual({
      grossMsat: 2_000_000n,
      depHubFeeMsat: 200_000n,
      arrHubFeeMsat: 400_000n,
      netMsat: 1_400_000n,
      finalizationBonusMsat: 0n,
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
      carrierBonusMsat: 0n,
    });
    expect(leg3).toEqual({
      grossMsat: 1_500_000n,
      depHubFeeMsat: 300_000n,
      arrHubFeeMsat: 150_000n,
      netMsat: 1_050_000n,
      finalizationBonusMsat: 0n,
    });

    // Doc totals row: gross Σ = pool, hubs Σ = 27% of it, carriers the rest.
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

describe('ECONOMICS.md §5-ter / ADR-016 — recipient claim pricing', () => {
  it('canonical claim at hub C (40 km done): pool residuo + Π_v, hub gets Π_h', () => {
    // Work pool 4.50 €, parcel 60 km from B: remaining pool 2.70 €; the full
    // quotas are unconsumed. Claim payment 2.70 + 0.35 = 3.05 €, Π_h 0.15 €.
    const pool = remainingPool(WORK, D, 60);
    expect(pool).toBe(2_700_000n);
    expect(priceClaim({ poolMsat: pool, carrierBonusMsat: CARRIER_QUOTA, hubBonusMsat: HUB_QUOTA })).toEqual({
      claimPaymentMsat: 3_050_000n,
      hubBonusMsat: HUB_QUOTA,
    });
  });

  it('claim at the ORIGIN hub: the full work pool plus Π_v (no fee — ADR-016)', () => {
    expect(
      priceClaim({ poolMsat: remainingPool(WORK, D, D), carrierBonusMsat: CARRIER_QUOTA, hubBonusMsat: HUB_QUOTA }),
    ).toEqual({ claimPaymentMsat: WORK + CARRIER_QUOTA, hubBonusMsat: HUB_QUOTA });
  });

  it('consumed Π_v contributes nothing; each part floors to a whole sat', () => {
    expect(
      priceClaim({ poolMsat: 1_234_567n, carrierBonusMsat: 0n, hubBonusMsat: 999n }),
    ).toEqual({ claimPaymentMsat: 1_234_000n, hubBonusMsat: 0n });
    // Floors are independent (like leg pricing), never on the sum.
    expect(
      priceClaim({ poolMsat: 1_500n, carrierBonusMsat: 1_500n, hubBonusMsat: 1_999n }),
    ).toEqual({ claimPaymentMsat: 2_000n, hubBonusMsat: 1_000n });
  });

  it('rejects negative inputs', () => {
    expect(() => priceClaim({ poolMsat: -1n, carrierBonusMsat: 0n, hubBonusMsat: 0n })).toThrow(EconomicsError);
    expect(() => priceClaim({ poolMsat: 0n, carrierBonusMsat: -1n, hubBonusMsat: 0n })).toThrow(EconomicsError);
    expect(() => priceClaim({ poolMsat: 0n, carrierBonusMsat: 0n, hubBonusMsat: -1n })).toThrow(EconomicsError);
  });
});

describe('boost (ECONOMICS.md §5 — work parts only reach the pool)', () => {
  it('joins the pool at boost time: pool = W × r/D + ΔW', () => {
    // A 1.00 € boost while the parcel sits 50 km out contributes its 0.90 €
    // work part; the 0.10 € bonus part accrues to the quotas, never here.
    const boost = splitCommitment(1_000_000n);
    expect(boost).toEqual({ workMsat: 900_000n, carrierBonusMsat: 70_000n, hubBonusMsat: 30_000n });
    expect(remainingPool(WORK, D, 50, [{ amountMsat: boost.workMsat, atRemainingKm: 50 }])).toBe(
      2_250_000n + 900_000n,
    );
  });

  it('decays proportionally afterwards: contribution ΔW × r / r_b', () => {
    // Halfway from the boost point the boost contributes half its work part —
    // a constant contribution would let split journeys overpay the pool.
    expect(remainingPool(WORK, D, 25, [{ amountMsat: 900_000n, atRemainingKm: 50 }])).toBe(
      1_125_000n + 450_000n,
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
    // Parcel 60 km from B with work pool 2.70 €; rerouted to a hub 80 km away.
    const segment = applyReroute(WORK, D, 60, 80);
    expect(segment).toEqual({ offerMsat: 2_700_000n, totalKm: 80 });
    // Paid legs are untouched: only future pricing uses the new segment.
    expect(remainingPool(segment.offerMsat, segment.totalKm, 40)).toBe(1_350_000n);
  });

  it('carries boosts into the frozen commitment', () => {
    const segment = applyReroute(WORK, D, 50, 30, [{ amountMsat: 900_000n, atRemainingKm: 50 }]);
    expect(segment).toEqual({ offerMsat: 2_250_000n + 900_000n, totalKm: 30 });
  });

  it('supports the delivered-then-reroute case (pool exhausted, boost required)', () => {
    const segment = applyReroute(WORK, D, 0, 20);
    expect(segment.offerMsat).toBe(0n);
    const pool = remainingPool(segment.offerMsat, segment.totalKm, 20, [
      { amountMsat: 1_800_000n, atRemainingKm: 20 },
    ]);
    expect(pool).toBe(1_800_000n);
  });

  it('rejects a non-positive new distance', () => {
    expect(() => applyReroute(P, D, 60, 0)).toThrow(EconomicsError);
  });
});

describe('cancellation compensation (f_o × work commitment, ADR-014)', () => {
  it('pays the origin hub what a single-leg journey would have grossed for it', () => {
    // 10% of the 4.50 € work pool: the bonus is excluded from this formula too.
    expect(cancellationCompensation(splitCommitment(P).workMsat, 1000)).toBe(450_000n);
  });

  it('floors to a whole sat', () => {
    expect(cancellationCompensation(4_500_001n, 1000)).toBe(450_000n);
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
      carrierBonusMsat: 0n,
    });
    expect(leg.grossMsat).toBe(1_666_000n);
    expect(leg.depHubFeeMsat).toBe(166_000n); // floor(166_600) to sat
    expect(leg.netMsat).toBe(1_666_000n - 2n * 166_000n);
    expect(leg.depHubFeeMsat + leg.arrHubFeeMsat + leg.netMsat).toBe(leg.grossMsat);
  });

  it('the carrier quota freeze floors to the sat too', () => {
    const leg = priceLeg({
      poolMsat: P,
      totalKm: D,
      remainingKm: 30,
      progressKm: 30,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: 350_999n, // accrued quota with sub-sat dust
    });
    expect(leg.finalizationBonusMsat).toBe(350_000n); // 999 msat stay with the sender
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
    carrierBonusMsat: 0n,
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

  it('rejects hub fees above the 30% cap, non-integer bp, NaN distances and negative amounts', () => {
    expect(() => priceLeg({ ...base, depHubFeeBp: 3001 })).toThrow(/between 0 and 3000/);
    expect(() => priceLeg({ ...base, arrHubFeeBp: 10.5 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, arrHubFeeBp: -1 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, remainingKm: Number.NaN })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, totalKm: 0 })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, poolMsat: -1n })).toThrow(EconomicsError);
    expect(() => priceLeg({ ...base, carrierBonusMsat: -1n })).toThrow(EconomicsError);
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

describe('Fase 2 punto 7 — estimateHubFeeRange (hub dashboard earning bracket)', () => {
  // Canonical: work pool 4.50 €, D = 100 km, hub at 10% (1000 bp).
  it('brackets the canonical origin-hub fee: min = shortest leg, max = single leg', () => {
    const range = estimateHubFeeRange({
      poolMsat: WORK,
      totalKm: D,
      remainingKm: D,
      hubFeeBp: 1000,
    });
    // MAX: single leg on the whole pool → 10% × 4.50 € = 0.45 €.
    expect(range.maxMsat).toBe(450_000n);
    // MIN: shortest leg Δr = max(5 km, 5% × 100) = 5 km → gross 0.225 €, fee
    // 22.5 sats floored to a whole sat = 22 sats (same floor as priceLeg).
    expect(range.minMsat).toBe(22_000n);
    expect(range.minMsat <= range.maxMsat).toBe(true);
  });

  // The bounds must be real prices the engine could freeze, never above them:
  // the max equals a single delivering leg's dep fee, the min a shortest leg's.
  it('agrees exactly with priceLeg at both ends of the range', () => {
    const legBase = {
      poolMsat: WORK,
      totalKm: D,
      remainingKm: D,
      depHubFeeBp: 1000,
      arrHubFeeBp: 1000,
      carrierBonusMsat: 0n,
    };
    const single = priceLeg({ ...legBase, progressKm: D });
    const shortest = priceLeg({ ...legBase, progressKm: minLegProgressKm(D) });
    const range = estimateHubFeeRange({
      poolMsat: WORK,
      totalKm: D,
      remainingKm: D,
      hubFeeBp: 1000,
    });
    expect(range.maxMsat).toBe(single.depHubFeeMsat);
    expect(range.minMsat).toBe(shortest.depHubFeeMsat);
  });

  it('collapses to a point when the parcel is closer than the min-progress floor', () => {
    // D = 4 km ⇒ min progress = max(5 km, 0.2 km) = 5 km > r: only the final
    // delivering leg is admissible, so the earning is a single figure.
    const range = estimateHubFeeRange({
      poolMsat: 1_000_000n,
      totalKm: 4,
      remainingKm: 4,
      hubFeeBp: 1000,
    });
    expect(range.minMsat).toBe(range.maxMsat);
    expect(range.maxMsat).toBe(100_000n); // 10% × 1.00 €
  });

  it('a 0% hub earns nothing across the whole range', () => {
    const range = estimateHubFeeRange({ poolMsat: WORK, totalKm: D, remainingKm: D, hubFeeBp: 0 });
    expect(range).toEqual({ minMsat: 0n, maxMsat: 0n });
  });

  it('validates its inputs', () => {
    const ok = { poolMsat: WORK, totalKm: D, remainingKm: D, hubFeeBp: 1000 };
    expect(() => estimateHubFeeRange({ ...ok, hubFeeBp: 3001 })).toThrow(EconomicsError);
    expect(() => estimateHubFeeRange({ ...ok, hubFeeBp: -1 })).toThrow(EconomicsError);
    expect(() => estimateHubFeeRange({ ...ok, remainingKm: 0 })).toThrow(EconomicsError);
    expect(() => estimateHubFeeRange({ ...ok, poolMsat: -1n })).toThrow(EconomicsError);
  });
});
