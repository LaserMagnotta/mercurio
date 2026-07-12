// Property tests over randomized journeys (deterministic: fixed-seed PRNG, so
// a green run is green forever). They pin down the four invariants the engine
// must never violate (ECONOMICS.md, ARCHITECTURE.md §5 "invarianti"):
//
//   1. Σ gross ≤ P + Σ boosts, always — even across boosts and reroutes.
//   2. No amount is ever negative, and net + fees = gross exactly.
//   3. Splitting a leg in two never increases the carriers' gross total.
//   4. With every hub at the same fee f, hubs collectively earn 2f × P
//      (exact up to the documented sat-flooring bounds).
//
// Generators work in integer METERS and convert to km only at the API
// boundary: the engine quantizes km to meters internally, so float km would
// accumulate ±1 m of drift per leg and blur the exact rounding bounds below.

import { describe, expect, it } from 'vitest';
import type { PoolBoost } from '@mercurio/shared';
import { applyReroute, priceLeg, remainingPool } from './economics';

/** mulberry32 — tiny deterministic PRNG; quality is irrelevant, determinism is not. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const km = (meters: number): number => meters / 1000;
const randMsat = (rand: () => number, max: number): bigint => 1n + BigInt(Math.floor(rand() * max));
const randFeeBp = (rand: () => number): number => Math.floor(rand() * 3001);
/** Random integer in [min, max] inclusive. */
const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));
/** Minimum leg progress in meters: max(5 km, 5% of D), mirroring the guard. */
const minProgressM = (totalM: number): number => Math.max(5000, Math.ceil(totalM / 20));

interface JourneyStats {
  offerMsat: bigint;
  boostTotalMsat: bigint;
  grossTotalMsat: bigint;
  legCount: number;
  completed: boolean;
}

/**
 * Drive a random journey through the public API exactly as production will:
 * recompute the pool from (segment, r, boosts) before each leg, occasionally
 * boost or reroute at a standstill.
 */
function runRandomJourney(rand: () => number, allowBoostsAndReroutes: boolean): JourneyStats {
  const offerMsat = randMsat(rand, 1e10);
  let totalM = randInt(rand, 10_000, 2_000_000);
  let segmentOfferMsat = offerMsat;
  let boosts: PoolBoost[] = [];
  let remainingM = totalM;
  let boostTotalMsat = 0n;
  let grossTotalMsat = 0n;
  let legCount = 0;
  let reroutes = 0;
  const maxLegs = 12;

  while (remainingM > 0 && legCount < maxLegs) {
    if (allowBoostsAndReroutes && rand() < 0.15) {
      const boost = { amountMsat: randMsat(rand, 1e9), atRemainingKm: km(remainingM) };
      boosts = [...boosts, boost];
      boostTotalMsat += boost.amountMsat;
    }
    if (allowBoostsAndReroutes && reroutes < 3 && rand() < 0.1) {
      const newRemainingM = randInt(rand, 10_000, 2_000_000);
      const segment = applyReroute(segmentOfferMsat, km(totalM), km(remainingM), km(newRemainingM), boosts);
      segmentOfferMsat = segment.offerMsat;
      totalM = newRemainingM;
      boosts = [];
      remainingM = newRemainingM;
      reroutes += 1;
      continue;
    }

    const poolMsat = remainingPool(segmentOfferMsat, km(totalM), km(remainingM), boosts);
    const minM = minProgressM(totalM);
    // Force completion on the last allowed iteration so most journeys finish.
    const progressM =
      remainingM <= minM || rand() < 0.3 || legCount === maxLegs - 1
        ? remainingM
        : randInt(rand, minM, remainingM);
    const leg = priceLeg({
      poolMsat,
      totalKm: km(totalM),
      remainingKm: km(remainingM),
      progressKm: km(progressM),
      depHubFeeBp: randFeeBp(rand),
      arrHubFeeBp: randFeeBp(rand),
    });

    // Invariant 2: nothing negative, exact reconciliation, never above pool.
    expect(leg.grossMsat >= 0n).toBe(true);
    expect(leg.depHubFeeMsat >= 0n).toBe(true);
    expect(leg.arrHubFeeMsat >= 0n).toBe(true);
    expect(leg.netMsat >= 0n).toBe(true);
    expect(leg.depHubFeeMsat + leg.arrHubFeeMsat + leg.netMsat).toBe(leg.grossMsat);
    expect(leg.grossMsat <= poolMsat).toBe(true);

    grossTotalMsat += leg.grossMsat;
    legCount += 1;
    remainingM -= progressM;
  }

  return { offerMsat, boostTotalMsat, grossTotalMsat, legCount, completed: remainingM === 0 };
}

describe('property: pool conservation (Σ gross ≤ P + Σ boosts)', () => {
  it('holds across 500 random journeys with boosts and reroutes', () => {
    const rand = mulberry32(0xa11ce);
    for (let i = 0; i < 500; i += 1) {
      const journey = runRandomJourney(rand, true);
      expect(journey.grossTotalMsat <= journey.offerMsat + journey.boostTotalMsat).toBe(true);
    }
  });

  it('on completed journeys the whole budget is distributed, minus bounded rounding', () => {
    const rand = mulberry32(0xb0b);
    for (let i = 0; i < 300; i += 1) {
      const journey = runRandomJourney(rand, false);
      if (!journey.completed) continue;
      // Per leg, gross understates the exact share P×Δr/D by < 1000 msat (sat
      // floor) + 1 msat (pool msat truncation): undistributed < 1001 msat/leg.
      const bound = BigInt(journey.legCount) * 1001n;
      expect(journey.offerMsat - journey.grossTotalMsat < bound).toBe(true);
    }
  });
});

describe('property: splitting a leg in two never increases the carriers` total', () => {
  it('gross(Δr) ≥ gross(Δr₁) + gross(Δr₂) over 1000 random splits', () => {
    const rand = mulberry32(0xdeadbee);
    for (let i = 0; i < 1000; i += 1) {
      const totalM = randInt(rand, 25_000, 2_000_000);
      const offerMsat = randMsat(rand, 1e10);
      const boosts: PoolBoost[] =
        rand() < 0.3 ? [{ amountMsat: randMsat(rand, 1e9), atRemainingKm: km(totalM) }] : [];
      const minM = minProgressM(totalM);
      // A stretch long enough to split into two legs of ≥ minM each.
      const remainingM = randInt(rand, Math.min(2 * minM + 2, totalM), totalM);
      const progressM = randInt(rand, 2 * minM, remainingM);
      const firstM = randInt(rand, minM, progressM - minM);
      const fees = { depHubFeeBp: randFeeBp(rand), arrHubFeeBp: randFeeBp(rand) };

      const pool = remainingPool(offerMsat, km(totalM), km(remainingM), boosts);
      const whole = priceLeg({
        poolMsat: pool,
        totalKm: km(totalM),
        remainingKm: km(remainingM),
        progressKm: km(progressM),
        ...fees,
      });
      const first = priceLeg({
        poolMsat: pool,
        totalKm: km(totalM),
        remainingKm: km(remainingM),
        progressKm: km(firstM),
        ...fees,
      });
      const poolAfter = remainingPool(offerMsat, km(totalM), km(remainingM - firstM), boosts);
      const second = priceLeg({
        poolMsat: poolAfter,
        totalKm: km(totalM),
        remainingKm: km(remainingM - firstM),
        progressKm: km(progressM - firstM),
        ...fees,
      });

      expect(first.grossMsat + second.grossMsat <= whole.grossMsat).toBe(true);
      // Net comparison note: per-leg sat-flooring of fees favors the payer, so
      // with fees > 0 the split NETS may exceed the whole leg's net by < 1 sat
      // per extra fee event (< 4000 msat here) — dust, and splitting costs the
      // carrier a real extra handoff + bond anyway. With zero fees net = gross
      // and the inequality is exact (covered by the gross assert above).
      expect(first.netMsat + second.netMsat <= whole.netMsat + 4000n).toBe(true);
    }
  });
});

describe('property: with every hub at the same fee f, hubs earn 2f × P overall', () => {
  it('total hub fees match 2f×P within the documented flooring bounds (300 journeys)', () => {
    const rand = mulberry32(0xfee);
    for (let i = 0; i < 300; i += 1) {
      const offerMsat = randMsat(rand, 1e10);
      const totalM = randInt(rand, 10_000, 2_000_000);
      const feeBp = BigInt(randFeeBp(rand));
      let remainingM = totalM;
      let grossTotal = 0n;
      let feeTotal = 0n;
      let legCount = 0;
      while (remainingM > 0) {
        const minM = minProgressM(totalM);
        const progressM =
          remainingM <= minM || rand() < 0.3 || legCount === 9
            ? remainingM
            : randInt(rand, minM, remainingM);
        const leg = priceLeg({
          poolMsat: remainingPool(offerMsat, km(totalM), km(remainingM)),
          totalKm: km(totalM),
          remainingKm: km(remainingM),
          progressKm: km(progressM),
          depHubFeeBp: Number(feeBp),
          arrHubFeeBp: Number(feeBp),
        });
        grossTotal += leg.grossMsat;
        feeTotal += leg.depHubFeeMsat + leg.arrHubFeeMsat;
        legCount += 1;
        remainingM -= progressM;
      }

      // Upper bound is exact: each fee is floored, so Σ fees ≤ 2f × Σ gross ≤ 2f × P.
      expect(feeTotal * 10_000n <= 2n * feeBp * offerMsat).toBe(true);
      // Lower bound: per leg, each of the two fee floors loses < 1000 msat and
      // the gross understates its exact share by < 1001 msat, of which hubs
      // would have taken 2f. Scaled by 10_000 to stay in integers:
      //   Σfees × 10_000 ≥ 2f×P − legs × (2f×1001 + 2×1000×10_000)
      const legs = BigInt(legCount);
      const lowerBound = 2n * feeBp * offerMsat - legs * (2n * feeBp * 1001n + 20_000_000n);
      expect(feeTotal * 10_000n >= lowerBound).toBe(true);
      // Same-f invariant on what was actually distributed: hubs took exactly
      // 2f of every gross, minus only the per-leg fee flooring.
      expect(feeTotal * 10_000n >= 2n * feeBp * grossTotal - legs * 20_000_000n).toBe(true);
    }
  });
});
