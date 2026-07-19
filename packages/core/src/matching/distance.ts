// Distance estimation behind the DistanceProvider interface (ADR-007).
//
// MVP metric: haversine × circuity factor 1.3 (typical road/great-circle
// ratio on the European network). The same metric prices legs (Δr,
// ECONOMICS.md) and filters detours (MATCHING.md), so systematic errors
// (mountains, lakes) distort numerator and denominator alike and the
// convenience/cost RATIOS hold up better than the absolute values do.
// The interface is the upgrade path to real routing (OSRM/Valhalla) without
// touching the domain — to be done when real complaints justify it.

import type { GeoPoint } from '@mercurio/shared';
import { ROAD_CIRCUITY_FACTOR } from '@mercurio/shared';

export interface DistanceProvider {
  /** Road-distance estimate in km. MVP: haversine × 1.3. Future: OSRM. */
  distanceKm(a: GeoPoint, b: GeoPoint): number;
}

/**
 * A provider that cannot answer a specific pair throws this — and nothing
 * else — to say so (ADR-031: a road router can hold no route for one
 * combination while answering every other). The matching engine treats it
 * as "this drop hub is not available this refresh" and skips the hub, the
 * same self-disqualification as a fee above the cap; anywhere outside that
 * per-hub loop an unresolved pair is still a caller bug and propagates.
 */
export class UnresolvedDistanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnresolvedDistanceError';
  }
}

/** IUGG mean Earth radius, km. */
const EARTH_RADIUS_KM = 6371.0088;

const toRadians = (deg: number): number => (deg * Math.PI) / 180;

function assertValidPoint(p: GeoPoint, name: string): void {
  if (
    !Number.isFinite(p.lat) ||
    !Number.isFinite(p.lng) ||
    Math.abs(p.lat) > 90 ||
    Math.abs(p.lng) > 180
  ) {
    throw new RangeError(`${name} must be valid WGS84 degrees, got lat=${p.lat} lng=${p.lng}`);
  }
}

/** Great-circle distance in km on the mean-radius sphere. */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  assertValidPoint(a, 'a');
  assertValidPoint(b, 'b');
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * sinLng * sinLng;
  // asin form is numerically stable for the short distances we care about
  // (atan2 form only wins near the antipodes, irrelevant for parcel routes).
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The production DistanceProvider: haversine × k, k = 1.3 by default.
 * k is exposed for recalibration against real-world data (ADR-007), not for
 * per-call tweaking: build one provider and inject it everywhere, so price
 * and matching always share the same metric.
 */
export function createHaversineDistanceProvider(
  circuityFactor: number = ROAD_CIRCUITY_FACTOR,
): DistanceProvider {
  if (!Number.isFinite(circuityFactor) || circuityFactor < 1) {
    throw new RangeError(`circuityFactor must be a finite number >= 1, got ${circuityFactor}`);
  }
  return {
    distanceKm: (a, b) => haversineKm(a, b) * circuityFactor,
  };
}
