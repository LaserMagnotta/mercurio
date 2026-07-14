// Carrier route ordering (ADR-015, MATCHING.md §8). Pure function, no I/O.
//
// Shortest OPEN path origin → …stops… → destination visiting every stop
// exactly once, under the precedence constraint "pickup before drop" for
// each shipment on board. Exact search: a Held-Karp subset DP over
// ≤ MAX_ROUTE_WAYPOINTS stops (9 — also the Google Maps URL waypoint cap)
// costs at most 2⁹ × 9² transitions, so optimality is free at this size and
// nothing heuristic needs testing (ADR-015: "il costo dell'ottimo esatto a
// n ≤ 9 è nullo").
//
// Distances are quantized to integer meters before summing, mirroring the
// board engine: integer sums are order-independent and exact, so "optimal"
// is well-defined and the brute-force comparison in the tests can require
// strict equality instead of a float tolerance.

import type { GeoPoint, RouteStop } from '@mercurio/shared';
import { MAX_ROUTE_WAYPOINTS } from '@mercurio/shared';
import type { DistanceProvider } from './distance';

const kmToMeters = (km: number): number => Math.round(km * 1000);

/** Canonical stop order (shipmentId, pickup-before-drop, hubId): the DP
 *  breaks cost ties by index, so sorting first makes the result independent
 *  of the caller's array order (property-tested stability). */
function canonicalCompare(a: RouteStop, b: RouteStop): number {
  if (a.shipmentId !== b.shipmentId) return a.shipmentId < b.shipmentId ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'pickup' ? -1 : 1;
  return a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0;
}

/**
 * Order the carrier's stops into the shortest open path O → … → Dc that
 * respects pickup-before-drop per shipment (ADR-015, MATCHING.md §8).
 *
 * A drop whose pickup is not among the stops (parcel already on board) is
 * unconstrained; when a shipment contributes several stops of the same kind,
 * every pickup precedes every drop of that shipment. Throws RangeError above
 * MAX_ROUTE_WAYPOINTS — the caller decides what to leave unrouted.
 */
export function orderRouteWaypoints(
  origin: GeoPoint,
  destination: GeoPoint,
  stops: readonly RouteStop[],
  distance: DistanceProvider,
): RouteStop[] {
  if (stops.length > MAX_ROUTE_WAYPOINTS) {
    throw new RangeError(
      `orderRouteWaypoints routes at most ${MAX_ROUTE_WAYPOINTS} stops, got ${stops.length}`,
    );
  }
  const ordered = [...stops].sort(canonicalCompare);
  const n = ordered.length;
  if (n === 0) return [];

  // Pairwise distances in integer meters, computed once.
  const fromOrigin = ordered.map((s) => kmToMeters(distance.distanceKm(origin, s.point)));
  const toDest = ordered.map((s) => kmToMeters(distance.distanceKm(s.point, destination)));
  const between = ordered.map((a) =>
    ordered.map((b) => kmToMeters(distance.distanceKm(a.point, b.point))),
  );

  // mustPrecede[i]: bitmask of the stops that must be visited before stop i —
  // the pickups of the same shipment when i is a drop.
  const mustPrecede = ordered.map((stop) => {
    if (stop.kind !== 'drop') return 0;
    let mask = 0;
    for (let j = 0; j < n; j += 1) {
      const other = ordered[j]!;
      if (other.kind === 'pickup' && other.shipmentId === stop.shipmentId) mask |= 1 << j;
    }
    return mask;
  });

  // dp[mask][last] = min meters for origin → (stops of mask, ending at last).
  const size = 1 << n;
  const dp: number[][] = Array.from({ length: size }, () => new Array<number>(n).fill(Infinity));
  const parent: number[][] = Array.from({ length: size }, () => new Array<number>(n).fill(-1));
  for (let i = 0; i < n; i += 1) {
    if (mustPrecede[i] === 0) dp[1 << i]![i] = fromOrigin[i]!;
  }
  for (let mask = 1; mask < size; mask += 1) {
    for (let last = 0; last < n; last += 1) {
      const cost = dp[mask]![last]!;
      if ((mask & (1 << last)) === 0 || !Number.isFinite(cost)) continue;
      for (let next = 0; next < n; next += 1) {
        if (mask & (1 << next)) continue;
        // Precedence guard: every required predecessor already visited.
        if ((mustPrecede[next]! & mask) !== mustPrecede[next]!) continue;
        const nextMask = mask | (1 << next);
        const nextCost = cost + between[last]![next]!;
        // Strict < keeps the first (lowest-index) parent on cost ties: with
        // the canonical sort above the whole result is deterministic.
        if (nextCost < dp[nextMask]![next]!) {
          dp[nextMask]![next] = nextCost;
          parent[nextMask]![next] = last;
        }
      }
    }
  }

  const full = size - 1;
  let bestLast = -1;
  let bestCost = Infinity;
  for (let i = 0; i < n; i += 1) {
    const cost = dp[full]![i]! + toDest[i]!;
    if (cost < bestCost) {
      bestCost = cost;
      bestLast = i;
    }
  }
  // Unreachable: pickups are unconstrained, so a feasible order (all pickups
  // first, then all drops) always exists.
  if (bestLast < 0) throw new Error('orderRouteWaypoints: no feasible order');

  const indices: number[] = [];
  for (let mask = full, last = bestLast; last >= 0; ) {
    indices.push(last);
    const prev = parent[mask]![last]!;
    mask &= ~(1 << last);
    last = prev;
  }
  indices.reverse();
  return indices.map((i) => ordered[i]!);
}
