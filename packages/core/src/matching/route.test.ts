// orderRouteWaypoints (ADR-015, MATCHING.md §8): exact-search route ordering.
//
// The guarantees the ADR asks the tests to hold:
//   1. Optimality — on every instance small enough to brute-force, the DP's
//      total cost equals the exhaustive minimum over all precedence-feasible
//      permutations (integer meters, strict equality).
//   2. Precedence — every returned order visits each shipment's pickup
//      before its drop, whatever the geometry (property over random
//      instances up to the MAX_ROUTE_WAYPOINTS cap).
//   3. Stability — shuffling the input array never changes the output.

import { describe, expect, it } from 'vitest';
import type { GeoPoint, RouteStop } from '@mercurio/shared';
import { MAX_ROUTE_WAYPOINTS } from '@mercurio/shared';
import type { DistanceProvider } from './distance';
import { orderRouteWaypoints } from './route';

/** Plane geometry: coordinates in km on lng (x) / lat (y). */
const euclidean: DistanceProvider = {
  distanceKm: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat),
};

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

/** Random point on an integer-meter grid inside a ~300×300 km square. */
const randPoint = (rand: () => number): GeoPoint => ({
  lng: randInt(rand, 0, 300_000) / 1000,
  lat: randInt(rand, 0, 300_000) / 1000,
});

const stop = (
  shipmentId: string,
  kind: RouteStop['kind'],
  lng: number,
  lat: number,
  hubId = `${shipmentId}-${kind}`,
): RouteStop => ({ hubId, point: { lat, lng }, kind, shipmentId });

/** Random stop set: `pairs` full pickup+drop shipments plus `dropsOnly`
 *  shipments already on board (their pickup happened, only the drop stop
 *  remains — the unconstrained case the API produces for picked_up legs). */
function randStops(rand: () => number, pairs: number, dropsOnly: number): RouteStop[] {
  const stops: RouteStop[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const p = randPoint(rand);
    const d = randPoint(rand);
    stops.push(stop(`ship-${i}`, 'pickup', p.lng, p.lat), stop(`ship-${i}`, 'drop', d.lng, d.lat));
  }
  for (let i = 0; i < dropsOnly; i += 1) {
    const d = randPoint(rand);
    stops.push(stop(`aboard-${i}`, 'drop', d.lng, d.lat));
  }
  return stops;
}

const kmToMeters = (km: number): number => Math.round(km * 1000);

/** Integer-meter cost of a stop sequence — the same arithmetic as the DP,
 *  so brute force and engine are comparable with strict equality. */
function pathMeters(
  origin: GeoPoint,
  destination: GeoPoint,
  sequence: readonly RouteStop[],
): number {
  let total = 0;
  let at = origin;
  for (const s of sequence) {
    total += kmToMeters(euclidean.distanceKm(at, s.point));
    at = s.point;
  }
  return total + kmToMeters(euclidean.distanceKm(at, destination));
}

function respectsPrecedence(sequence: readonly RouteStop[]): boolean {
  const dropped = new Set<string>();
  for (const s of sequence) {
    if (s.kind === 'pickup' && dropped.has(s.shipmentId)) return false;
    if (s.kind === 'drop') dropped.add(s.shipmentId);
  }
  return true;
}

/** Exhaustive minimum over every precedence-feasible permutation. */
function bruteForceMeters(
  origin: GeoPoint,
  destination: GeoPoint,
  stops: readonly RouteStop[],
): number {
  let best = Infinity;
  const permute = (sequence: RouteStop[], remaining: RouteStop[]): void => {
    if (remaining.length === 0) {
      best = Math.min(best, pathMeters(origin, destination, sequence));
      return;
    }
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i]!;
      // Prune: a drop may only follow its pickup when the pickup is listed.
      if (
        candidate.kind === 'drop' &&
        remaining.some((r) => r.kind === 'pickup' && r.shipmentId === candidate.shipmentId)
      ) {
        continue;
      }
      permute(
        [...sequence, candidate],
        remaining.filter((_, j) => j !== i),
      );
    }
  };
  permute([], [...stops]);
  return best;
}

/** Fisher–Yates with the injected PRNG. */
function shuffled<T>(rand: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randInt(rand, 0, i);
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

describe('orderRouteWaypoints', () => {
  it('returns [] with no stops and the single stop alone', () => {
    const origin = { lat: 0, lng: 0 };
    const dest = { lat: 0, lng: 100 };
    expect(orderRouteWaypoints(origin, dest, [], euclidean)).toEqual([]);
    const only = stop('s1', 'drop', 40, 10);
    expect(orderRouteWaypoints(origin, dest, [only], euclidean)).toEqual([only]);
  });

  it('orders the ADR-015 motivating case: two shipments, no absurd zig-zag', () => {
    // Trip west→east along y=0. Shipment A: pickup at x=20, drop at x=80.
    // Shipment B: pickup at x=30, drop at x=60. Acceptance order (all of A,
    // then all of B) would zig-zag back west; the optimum interleaves.
    const origin = { lat: 0, lng: 0 };
    const dest = { lat: 0, lng: 100 };
    const stops = [
      stop('A', 'pickup', 20, 2),
      stop('A', 'drop', 80, 2),
      stop('B', 'pickup', 30, -2),
      stop('B', 'drop', 60, -2),
    ];
    const route = orderRouteWaypoints(origin, dest, stops, euclidean);
    expect(route.map((s) => s.hubId)).toEqual(['A-pickup', 'B-pickup', 'B-drop', 'A-drop']);
  });

  it('a drop without its pickup among the stops is unconstrained', () => {
    // Parcel already aboard: its drop at x=10 comes first even though the
    // other shipment's pickup-drop pair sits later on the route.
    const origin = { lat: 0, lng: 0 };
    const dest = { lat: 0, lng: 100 };
    const stops = [
      stop('aboard', 'drop', 10, 0),
      stop('other', 'pickup', 40, 0),
      stop('other', 'drop', 70, 0),
    ];
    const route = orderRouteWaypoints(origin, dest, stops, euclidean);
    expect(route.map((s) => s.hubId)).toEqual(['aboard-drop', 'other-pickup', 'other-drop']);
  });

  it('throws RangeError above MAX_ROUTE_WAYPOINTS', () => {
    const origin = { lat: 0, lng: 0 };
    const dest = { lat: 0, lng: 100 };
    const tooMany = Array.from({ length: MAX_ROUTE_WAYPOINTS + 1 }, (_, i) =>
      stop(`s${i}`, 'drop', i, 0),
    );
    expect(() => orderRouteWaypoints(origin, dest, tooMany, euclidean)).toThrow(RangeError);
  });

  it('matches the brute-force optimum on random small instances', () => {
    const rand = mulberry32(20260714);
    for (let round = 0; round < 60; round += 1) {
      const pairs = randInt(rand, 0, 3);
      const dropsOnly = randInt(rand, 0, 7 - pairs * 2);
      const stops = randStops(rand, pairs, dropsOnly);
      const origin = randPoint(rand);
      const dest = randPoint(rand);
      const route = orderRouteWaypoints(origin, dest, stops, euclidean);
      expect(pathMeters(origin, dest, route)).toBe(bruteForceMeters(origin, dest, stops));
    }
  });

  it('property: every returned order is a permutation respecting precedence', () => {
    const rand = mulberry32(42);
    for (let round = 0; round < 120; round += 1) {
      const pairs = randInt(rand, 0, 4);
      const dropsOnly = randInt(rand, 0, MAX_ROUTE_WAYPOINTS - pairs * 2);
      const stops = randStops(rand, pairs, dropsOnly);
      const origin = randPoint(rand);
      const dest = randPoint(rand);
      const route = orderRouteWaypoints(origin, dest, shuffled(rand, stops), euclidean);
      expect(route).toHaveLength(stops.length);
      expect(new Set(route)).toEqual(new Set(stops));
      expect(respectsPrecedence(route)).toBe(true);
    }
  });

  it('property: shuffling the input never changes the output (stability)', () => {
    const rand = mulberry32(7);
    for (let round = 0; round < 40; round += 1) {
      const pairs = randInt(rand, 1, 4);
      const stops = randStops(rand, pairs, 0);
      const origin = randPoint(rand);
      const dest = randPoint(rand);
      const reference = orderRouteWaypoints(origin, dest, stops, euclidean);
      for (let shuffle = 0; shuffle < 3; shuffle += 1) {
        const again = orderRouteWaypoints(origin, dest, shuffled(rand, stops), euclidean);
        expect(again).toEqual(reference);
      }
    }
  });
});
