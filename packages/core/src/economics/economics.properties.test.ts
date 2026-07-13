// Property tests over randomized journeys (deterministic: fixed-seed PRNG, so
// a green run is green forever). They pin down the invariants the engine must
// never violate (ECONOMICS.md, ADR-014, ARCHITECTURE.md §5 "invarianti"):
//
//   1. Σ gross ≤ 90% × (P + Σ boosts) and Σ bonus paid ≤ 10% × (P + Σ boosts),
//      always — even across boosts and reroutes; the sender never owes more
//      than P + Σ boosts in total.
//   2. No amount is ever negative, and net + fees = gross exactly (the bonus
//      sits outside that identity and pays no fees).
//   3. Splitting a leg in two never increases the carriers' gross total.
//   4. With every hub at the same fee f, hubs collectively earn 2f × W over
//      the work pool W (exact up to the documented sat-flooring bounds).
//
// Generators work in integer METERS and convert to km only at the API
// boundary: the engine quantizes km to meters internally, so float km would
// accumulate ±1 m of drift per leg and blur the exact rounding bounds below.

import { describe, expect, it } from 'vitest';
import type { PoolBoost } from '@mercurio/shared';
import { applyReroute, floorToSat, priceLeg, remainingPool, splitCommitment } from './economics';

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
  /** Everything the sender committed: raw offer + raw boosts. */
  committedMsat: bigint;
  grossTotalMsat: bigint;
  /** Finalization bonus actually paid out (carrier share frozen on the final
   *  leg + hub share frozen at delivery), 0 if the journey never completed. */
  bonusPaidMsat: bigint;
  commitmentEvents: number;
  legCount: number;
  completed: boolean;
}

/**
 * Drive a random journey through the public API exactly as production will:
 * split every commitment once at ingestion (offer and boosts), keep the two
 * bonus quotas as shipment-level accruals, recompute the work pool from
 * (segment, r, boosts) before each leg, occasionally boost or reroute at a
 * standstill, and freeze the bonus shares when the journey completes.
 */
function runRandomJourney(rand: () => number, allowBoostsAndReroutes: boolean): JourneyStats {
  const offerMsat = randMsat(rand, 1e10);
  const offerSplit = splitCommitment(offerMsat);
  let totalM = randInt(rand, 10_000, 2_000_000);
  let segmentOfferMsat = offerSplit.workMsat;
  let boosts: PoolBoost[] = [];
  let remainingM = totalM;
  let committedMsat = offerMsat;
  let carrierQuotaMsat = offerSplit.carrierBonusMsat;
  let hubQuotaMsat = offerSplit.hubBonusMsat;
  let commitmentEvents = 1;
  let grossTotalMsat = 0n;
  let bonusPaidMsat = 0n;
  let legCount = 0;
  let reroutes = 0;
  const maxLegs = 12;

  while (remainingM > 0 && legCount < maxLegs) {
    if (allowBoostsAndReroutes && rand() < 0.15) {
      const boostMsat = randMsat(rand, 1e9);
      const split = splitCommitment(boostMsat);
      boosts = [...boosts, { amountMsat: split.workMsat, atRemainingKm: km(remainingM) }];
      committedMsat += boostMsat;
      carrierQuotaMsat += split.carrierBonusMsat;
      hubQuotaMsat += split.hubBonusMsat;
      commitmentEvents += 1;
    }
    if (allowBoostsAndReroutes && reroutes < 3 && rand() < 0.1) {
      const newRemainingM = randInt(rand, 10_000, 2_000_000);
      // The frozen pool is already work-denominated: no second carve-out.
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
      carrierBonusMsat: carrierQuotaMsat,
    });

    // Invariant 2: nothing negative, exact reconciliation, never above pool;
    // the bonus stays out of the gross/fees identity.
    expect(leg.grossMsat >= 0n).toBe(true);
    expect(leg.depHubFeeMsat >= 0n).toBe(true);
    expect(leg.arrHubFeeMsat >= 0n).toBe(true);
    expect(leg.netMsat >= 0n).toBe(true);
    expect(leg.finalizationBonusMsat >= 0n).toBe(true);
    expect(leg.depHubFeeMsat + leg.arrHubFeeMsat + leg.netMsat).toBe(leg.grossMsat);
    expect(leg.grossMsat <= poolMsat).toBe(true);

    grossTotalMsat += leg.grossMsat;
    legCount += 1;
    remainingM -= progressM;
    if (remainingM === 0) {
      // Delivery: the carrier share was frozen on this leg; the hub share is
      // frozen into its own hold and settles at recipient_pickup.
      expect(leg.finalizationBonusMsat).toBe(floorToSat(carrierQuotaMsat));
      bonusPaidMsat = leg.finalizationBonusMsat + floorToSat(hubQuotaMsat);
    } else {
      expect(leg.finalizationBonusMsat).toBe(0n);
    }
  }

  return {
    committedMsat,
    grossTotalMsat,
    bonusPaidMsat,
    commitmentEvents,
    legCount,
    completed: remainingM === 0,
  };
}

describe('property: conservation (Σ gross ≤ 90% × committed, Σ bonus ≤ 10% × committed)', () => {
  it('holds across 500 random journeys with boosts and reroutes', () => {
    const rand = mulberry32(0xa11ce);
    for (let i = 0; i < 500; i += 1) {
      const j = runRandomJourney(rand, true);
      expect(j.grossTotalMsat * 10_000n <= j.committedMsat * 9_000n).toBe(true);
      expect(j.bonusPaidMsat * 10_000n <= j.committedMsat * 1_000n).toBe(true);
      expect(j.grossTotalMsat + j.bonusPaidMsat <= j.committedMsat).toBe(true);
    }
  });

  it('on completed journeys the whole budget is distributed, minus bounded rounding', () => {
    const rand = mulberry32(0xb0b);
    for (let i = 0; i < 300; i += 1) {
      const j = runRandomJourney(rand, false);
      if (!j.completed) continue;
      // Per leg, gross understates the exact work share by < 1000 msat (sat
      // floor) + 1 msat (pool msat truncation); each commitment split loses
      // < 4 msat; each of the two bonus freezes loses < 1000 msat.
      const bound = BigInt(j.legCount) * 1001n + BigInt(j.commitmentEvents) * 4n + 2000n;
      expect(j.committedMsat - j.grossTotalMsat - j.bonusPaidMsat < bound).toBe(true);
    }
  });
});

describe('property: splitting a leg in two never increases the carriers` total', () => {
  it('gross(Δr) ≥ gross(Δr₁) + gross(Δr₂) over 1000 random splits', () => {
    const rand = mulberry32(0xdeadbee);
    for (let i = 0; i < 1000; i += 1) {
      const totalM = randInt(rand, 25_000, 2_000_000);
      const workMsat = randMsat(rand, 1e10);
      const boosts: PoolBoost[] =
        rand() < 0.3 ? [{ amountMsat: randMsat(rand, 1e9), atRemainingKm: km(totalM) }] : [];
      const minM = minProgressM(totalM);
      // A stretch long enough to split into two legs of ≥ minM each.
      const remainingM = randInt(rand, Math.min(2 * minM + 2, totalM), totalM);
      const progressM = randInt(rand, 2 * minM, remainingM);
      const firstM = randInt(rand, minM, progressM - minM);
      const fees = { depHubFeeBp: randFeeBp(rand), arrHubFeeBp: randFeeBp(rand) };

      const pool = remainingPool(workMsat, km(totalM), km(remainingM), boosts);
      const whole = priceLeg({
        poolMsat: pool,
        totalKm: km(totalM),
        remainingKm: km(remainingM),
        progressKm: km(progressM),
        carrierBonusMsat: 0n,
        ...fees,
      });
      const first = priceLeg({
        poolMsat: pool,
        totalKm: km(totalM),
        remainingKm: km(remainingM),
        progressKm: km(firstM),
        carrierBonusMsat: 0n,
        ...fees,
      });
      const poolAfter = remainingPool(workMsat, km(totalM), km(remainingM - firstM), boosts);
      const second = priceLeg({
        poolMsat: poolAfter,
        totalKm: km(totalM),
        remainingKm: km(remainingM - firstM),
        progressKm: km(progressM - firstM),
        carrierBonusMsat: 0n,
        ...fees,
      });

      expect(first.grossMsat + second.grossMsat <= whole.grossMsat).toBe(true);
      // Net comparison note: per-leg sat-flooring of fees favors the payer, so
      // with fees > 0 the split NETS may exceed the whole leg's net by < 1 sat
      // per extra fee event (< 4000 msat here) — dust, and splitting costs the
      // carrier a real extra handoff + bond anyway. With zero fees net = gross
      // and the inequality is exact (covered by the gross assert above).
      // The carrier bonus is orthogonal: it lands on whoever completes,
      // however the stretch is split (kept at 0n here to isolate the pool).
      expect(first.netMsat + second.netMsat <= whole.netMsat + 4000n).toBe(true);
    }
  });
});

describe('property: with every hub at the same fee f, hubs earn 2f × W overall', () => {
  it('total hub fees match 2f×W within the documented flooring bounds (300 journeys)', () => {
    const rand = mulberry32(0xfee);
    for (let i = 0; i < 300; i += 1) {
      const workMsat = randMsat(rand, 1e10);
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
          poolMsat: remainingPool(workMsat, km(totalM), km(remainingM)),
          totalKm: km(totalM),
          remainingKm: km(remainingM),
          progressKm: km(progressM),
          depHubFeeBp: Number(feeBp),
          arrHubFeeBp: Number(feeBp),
          carrierBonusMsat: 0n,
        });
        grossTotal += leg.grossMsat;
        feeTotal += leg.depHubFeeMsat + leg.arrHubFeeMsat;
        legCount += 1;
        remainingM -= progressM;
      }

      // Upper bound is exact: each fee is floored, so Σ fees ≤ 2f × Σ gross ≤ 2f × W.
      expect(feeTotal * 10_000n <= 2n * feeBp * workMsat).toBe(true);
      // Lower bound: per leg, each of the two fee floors loses < 1000 msat and
      // the gross understates its exact share by < 1001 msat, of which hubs
      // would have taken 2f. Scaled by 10_000 to stay in integers:
      //   Σfees × 10_000 ≥ 2f×W − legs × (2f×1001 + 2×1000×10_000)
      const legs = BigInt(legCount);
      const lowerBound = 2n * feeBp * workMsat - legs * (2n * feeBp * 1001n + 20_000_000n);
      expect(feeTotal * 10_000n >= lowerBound).toBe(true);
      // Same-f invariant on what was actually distributed: hubs took exactly
      // 2f of every gross, minus only the per-leg fee flooring.
      expect(feeTotal * 10_000n >= 2n * feeBp * grossTotal - legs * 20_000_000n).toBe(true);
    }
  });
});
