// Property tests for the board ranking over randomized plane geometries
// (deterministic: fixed-seed PRNG, so a green run is green forever). They pin
// down the guarantees MATCHING.md §6 asks the tests to hold:
//
//   1. No suggested hub (proposal or alternative) ever sits below the
//      progress threshold max(5 km, 5% × D) — except direct delivery to T.
//   2. Every displayed net/surplus agrees with the economics engine and the
//      trip's rate floor; isMatch ⇔ detour(H*) ≤ dev_max ∧ surplus(H*) ≥ 0.
//   3. The ordering is deterministic: shuffling the input arrays changes
//      nothing, matches come first, surplus never increases within a section.

import { describe, expect, it } from 'vitest';
import type { CarrierTrip, GeoPoint, MatchingHub, ShipmentAtHub } from '@mercurio/shared';
import { MAX_ALTERNATIVE_DROP_HUBS, MIN_LEG_PROGRESS_KM } from '@mercurio/shared';
import { priceLeg } from '../economics/economics';
import type { DistanceProvider } from './distance';
import { rankBoard } from './matching';

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

const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

/** Plane geometry: coordinates in km on lng (x) / lat (y). */
const euclidean: DistanceProvider = {
  distanceKm: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat),
};

/** Random point on integer-meter grid inside a ~300×300 km square. */
const randPoint = (rand: () => number): GeoPoint => ({
  lng: randInt(rand, 0, 300_000) / 1000,
  lat: randInt(rand, 0, 300_000) / 1000,
});

function randHub(rand: () => number, hubId: string): MatchingHub {
  return {
    hubId,
    location: randPoint(rand),
    active: rand() < 0.9,
    feeBp: randInt(rand, 0, 3000),
    maxDimsCm: {
      lengthCm: randInt(rand, 10, 120),
      widthCm: randInt(rand, 10, 120),
      heightCm: randInt(rand, 10, 120),
    },
    maxWeightG: randInt(rand, 100, 30_000),
    acceptsUndeclared: rand() < 0.7,
    walletConnected: rand() < 0.9,
    autoAcceptDeposits: rand() < 0.9,
  };
}

interface Scenario {
  trip: CarrierTrip;
  shipments: ShipmentAtHub[];
  hubs: MatchingHub[];
}

function randScenario(rand: () => number): Scenario {
  const trip: CarrierTrip = {
    origin: randPoint(rand),
    destination: randPoint(rand),
    maxDeviationKm: randInt(rand, 1000, 80_000) / 1000,
    minRateMsatPerKm: BigInt(randInt(rand, 0, 500_000)),
  };
  const hubs = Array.from({ length: randInt(rand, 4, 12) }, (_, i) => randHub(rand, `hub-${i}`));
  const shipments: ShipmentAtHub[] = [];
  const shipmentCount = randInt(rand, 1, 8);
  for (let i = 0; i < shipmentCount; i += 1) {
    const currentHub = hubs[randInt(rand, 0, hubs.length - 1)]!;
    const destHub = hubs[randInt(rand, 0, hubs.length - 1)]!;
    const remainingKm = euclidean.distanceKm(currentHub.location, destHub.location);
    // The journey may have started farther away: D ≥ r_S.
    const totalKm = (Math.round(remainingKm * 1000) + randInt(rand, 0, 100_000)) / 1000;
    shipments.push({
      shipmentId: `ship-${i}`,
      currentHubId: currentHub.hubId,
      destHubId: destHub.hubId,
      poolMsat: BigInt(randInt(rand, 0, 1e9)),
      // 0 sometimes: a consumed carrier quota (post-arrival reroute, ADR-014).
      carrierBonusMsat: rand() < 0.2 ? 0n : BigInt(randInt(rand, 0, 1e8)),
      totalKm,
      remainingKm,
      dimsCm: {
        lengthCm: randInt(rand, 5, 100),
        widthCm: randInt(rand, 5, 100),
        heightCm: randInt(rand, 5, 100),
      },
      weightG: randInt(rand, 50, 25_000),
      undeclared: rand() < 0.3,
    });
  }
  return { trip, shipments, hubs };
}

/** Fisher–Yates with the shared PRNG: deterministic shuffles. */
function shuffled<T>(rand: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randInt(rand, 0, i);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

describe('property: no suggested hub below the progress threshold', () => {
  it('every proposal and alternative makes max(5 km, 5% × D) of progress, unless it IS the destination (200 scenarios)', () => {
    const rand = mulberry32(0x5eed);
    for (let scenario = 0; scenario < 200; scenario += 1) {
      const { trip, shipments, hubs } = randScenario(rand);
      const hubById = new Map(hubs.map((h) => [h.hubId, h]));
      const board = rankBoard(trip, shipments, hubs, euclidean);
      for (const card of board) {
        const s = shipments.find((sh) => sh.shipmentId === card.shipmentId)!;
        const destHub = hubById.get(s.destHubId)!;
        const remainingM = Math.round(s.remainingKm * 1000);
        const totalM = Math.round(s.totalKm * 1000);
        for (const option of [card.bestDropHub, ...card.alternatives]) {
          if (option.hubId === s.destHubId) continue; // final hop: always admissible
          const hub = hubById.get(option.hubId)!;
          const progressM =
            remainingM - Math.round(euclidean.distanceKm(hub.location, destHub.location) * 1000);
          expect(progressM).toBeGreaterThanOrEqual(MIN_LEG_PROGRESS_KM * 1000);
          // 5% of D in exact integer form (progress × 20 ≥ D), as the engine checks it.
          expect(progressM * 20).toBeGreaterThanOrEqual(totalM);
        }
      }
    }
  });
});

describe('property: displayed amounts agree with the economics engine', () => {
  it('net re-prices exactly via priceLeg and surplus = net − rate_min × detour (200 scenarios)', () => {
    const rand = mulberry32(0xcafe);
    for (let scenario = 0; scenario < 200; scenario += 1) {
      const { trip, shipments, hubs } = randScenario(rand);
      const hubById = new Map(hubs.map((h) => [h.hubId, h]));
      const board = rankBoard(trip, shipments, hubs, euclidean);
      for (const card of board) {
        const s = shipments.find((sh) => sh.shipmentId === card.shipmentId)!;
        const currentHub = hubById.get(s.currentHubId)!;
        const destHub = hubById.get(s.destHubId)!;
        const remainingM = Math.round(s.remainingKm * 1000);
        for (const option of [card.bestDropHub, ...card.alternatives]) {
          const hub = hubById.get(option.hubId)!;
          const progressM =
            option.hubId === s.destHubId
              ? remainingM
              : remainingM -
                Math.round(euclidean.distanceKm(hub.location, destHub.location) * 1000);
          const pricing = priceLeg({
            poolMsat: s.poolMsat,
            totalKm: s.totalKm,
            remainingKm: s.remainingKm,
            progressKm: progressM / 1000,
            depHubFeeBp: currentHub.feeBp,
            arrHubFeeBp: hub.feeBp,
            carrierBonusMsat: s.carrierBonusMsat,
          });
          // The displayed net includes the finalization bonus, exposed as its
          // own field for the UI; only direct delivery may carry it (ADR-014).
          expect(option.netMsat).toBe(pricing.netMsat + pricing.finalizationBonusMsat);
          expect(option.finalizationBonusMsat).toBe(pricing.finalizationBonusMsat);
          if (option.hubId !== s.destHubId) expect(option.finalizationBonusMsat).toBe(0n);
          const thresholdMsat =
            (trip.minRateMsatPerKm * BigInt(Math.round(option.detourKm * 1000))) / 1000n;
          expect(option.surplusMsat).toBe(option.netMsat - thresholdMsat);
        }
        // isMatch is exactly the MATCHING.md criterion on H*.
        expect(card.isMatch).toBe(
          card.bestDropHub.detourKm <= trip.maxDeviationKm && card.bestDropHub.surplusMsat >= 0n,
        );
      }
    }
  });
});

describe('property: deterministic ordering', () => {
  it('shuffling the input arrays never changes the output (100 scenarios)', () => {
    const rand = mulberry32(0xd1ce);
    for (let scenario = 0; scenario < 100; scenario += 1) {
      const { trip, shipments, hubs } = randScenario(rand);
      const board = rankBoard(trip, shipments, hubs, euclidean);
      const shuffledBoard = rankBoard(
        trip,
        shuffled(rand, shipments),
        shuffled(rand, hubs),
        euclidean,
      );
      expect(shuffledBoard).toEqual(board);
    }
  });

  it('matches come first and surplus never increases within each section (100 scenarios)', () => {
    const rand = mulberry32(0xbead);
    for (let scenario = 0; scenario < 100; scenario += 1) {
      const { trip, shipments, hubs } = randScenario(rand);
      const board = rankBoard(trip, shipments, hubs, euclidean);
      for (let i = 1; i < board.length; i += 1) {
        const prev = board[i - 1]!;
        const curr = board[i]!;
        // Once a non-match appears, no match may follow.
        expect(Number(curr.isMatch)).toBeLessThanOrEqual(Number(prev.isMatch));
        if (prev.isMatch === curr.isMatch) {
          expect(curr.bestDropHub.surplusMsat <= prev.bestDropHub.surplusMsat).toBe(true);
        }
      }
      for (const card of board) {
        // Alternatives are surplus-descending too, and capped.
        expect(card.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVE_DROP_HUBS);
        for (let j = 1; j < card.alternatives.length; j += 1) {
          expect(card.alternatives[j]!.surplusMsat <= card.alternatives[j - 1]!.surplusMsat).toBe(
            true,
          );
        }
      }
    }
  });
});
