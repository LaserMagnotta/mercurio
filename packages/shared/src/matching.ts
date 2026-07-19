// Matching types shared between @mercurio/core (the board-ranking engine) and
// the API (which builds the inputs from DB rows and serves the ranked board).
// The algorithm itself lives in @mercurio/core/matching — pure functions only.

import type { Msat } from './index.js';

/** WGS84 coordinates in decimal degrees (DB columns `hubs.lat` / `hubs.lng`). */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** Parcel dimensions or hub size limits, in centimeters. */
export interface DimensionsCm {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

/**
 * The carrier's declared real journey (`carrier_trips` row) — declared BEFORE
 * seeing the board, so the ranking reflects the trip, not the other way
 * around (MATCHING.md §1).
 */
export interface CarrierTrip {
  /** O — current position / reference hub. */
  origin: GeoPoint;
  /** Dc — where the carrier is actually going. */
  destination: GeoPoint;
  /** dev_max — extra road the carrier tolerates, km. */
  maxDeviationKm: number;
  /** rate_min — minimum acceptable pay per km of detour, msat/km
   *  (`carrier_trips.min_rate_msat_per_km`). */
  minRateMsatPerKm: Msat;
}

/** A hub as the matching engine sees it (subset of the `hubs` row). */
export interface MatchingHub {
  hubId: string;
  location: GeoPoint;
  active: boolean;
  /** Configured fee in integer basis points (hubFeePercentToBp). */
  feeBp: number;
  maxDimsCm: DimensionsCm;
  maxWeightG: number;
  acceptsUndeclared: boolean;
  /** Candidate condition 3 (MATCHING.md §2, amended by ADR-029): the hub must
   *  have a connected wallet (it must be ABLE to bind its custody bond if it
   *  accepts). A MANUAL hub is a candidate too — its options are marked
   *  `requiresConfirmation` and choosing one opens a deposit request. */
  walletConnected: boolean;
  autoAcceptDeposits: boolean;
}

/** A shipment sitting AT_HUB, as shown on the board (MATCHING.md §1). */
export interface ShipmentAtHub {
  shipmentId: string;
  /** S — the hub currently holding the parcel. Must appear in the hubs list. */
  currentHubId: string;
  /** T — the destination hub. Must appear in the hubs list. */
  destHubId: string;
  /** Remaining WORK pool = remainingPool over the 90% work parts of the
   *  commitment (ECONOMICS.md §5-bis, ADR-014), msat. */
  poolMsat: Msat;
  /** Accrued carrier quota Π_v of the finalization bonus (ADR-014): what the
   *  leg delivering to T would earn on top of its net; 0n once consumed by an
   *  earlier arrival at the destination. */
  carrierBonusMsat: Msat;
  /** D — segment distance frozen at creation (or at the last reroute), km. */
  totalKm: number;
  /** r_S = d(S, T) — remaining distance to the destination, km. */
  remainingKm: number;
  dimsCm: DimensionsCm;
  weightG: number;
  undeclared: boolean;
}

/** One admissible drop hub H for a (trip, shipment) pair, priced. */
export interface DropHubOption {
  hubId: string;
  /** detour(H) = d(O,S) + d(S,H) + d(H,Dc) − d(O,Dc), quantized to meters. */
  detourKm: number;
  /** What the carrier collects for the leg S→H: gross × (1 − f_S − f_H),
   *  plus the finalization bonus when H = T (MATCHING.md §2, ADR-014). */
  netMsat: Msat;
  /** Carrier share of the finalization bonus included in netMsat — a separate
   *  field so the UI can show the "premio consegna" line; 0n unless H = T. */
  finalizationBonusMsat: Msat;
  /** net − rate_min × detour: what the leg pays beyond the carrier's floor.
   *  Negative = how far it falls short of being worth it. */
  surplusMsat: Msat;
  /** ADR-029 §3: true when the hub is manual — dropping here opens a deposit
   *  request instead of booking instantly ("richiede conferma"). */
  requiresConfirmation: boolean;
}

/** One board card: a shipment with its proposed drop hub and alternatives. */
export interface MatchCandidate {
  shipmentId: string;
  /** H* — argmax surplus among candidates within dev_max (MATCHING.md §2). */
  bestDropHub: DropHubOption;
  /** Up to MAX_ALTERNATIVE_DROP_HUBS runner-ups, surplus-descending. */
  alternatives: DropHubOption[];
  /** detour(H*) ≤ dev_max AND surplus(H*) ≥ 0 — the "Per te" section. */
  isMatch: boolean;
}

/**
 * One stop of a carrier's route (ADR-015): the pickup or drop hub of a leg
 * (or of a board preview). `shipmentId` binds the pickup to its drop so the
 * route optimizer can enforce pickup-before-drop per shipment.
 */
export interface RouteStop {
  hubId: string;
  point: GeoPoint;
  kind: 'pickup' | 'drop';
  shipmentId: string;
}

/** Hard cap on the stops orderRouteWaypoints will route (ADR-015): real
 *  trips carry few waypoints (≤ 8 stops ≈ 4 shipments) and Google Maps
 *  direction URLs accept at most 9 waypoints — beyond it the UI lists the
 *  unrouted stops instead. */
export const MAX_ROUTE_WAYPOINTS = 9;

/** Road/great-circle circuity factor k: d = haversine × k (ADR-007). */
export const ROAD_CIRCUITY_FACTOR = 1.3;

/** Which metric froze a shipment's money distances (ADR-031). Chosen at
 *  creation — 'road' when the OSRM router resolves the route, 'haversine'
 *  (ADR-007) otherwise — and never changed afterwards, reroutes included:
 *  the pool math divides distances by distances, and numerator and
 *  denominator must never come from different metrics. */
export const DISTANCE_METRICS = ['haversine', 'road'] as const;
export type DistanceMetric = (typeof DISTANCE_METRICS)[number];

/** Alternative drop hubs shown on a board card ("2–3", MATCHING.md §2). */
export const MAX_ALTERNATIVE_DROP_HUBS = 3;

/** Observation window for both rate suggesters, days (MATCHING.md §4–5). */
export const RATE_WINDOW_DAYS = 90;

/** Below this many observations the suggesters stay on their cold-start
 *  default: too few samples are easier to manipulate than to learn from. */
export const MIN_RATE_OBSERVATIONS = 30;

/** Observations with a detour below 1 km are discarded: the €/km ratio
 *  explodes as the denominator approaches zero and means nothing. */
export const MIN_OBSERVATION_DETOUR_KM = 1;

/** Cold-start carrier rate: ballpark marginal cost per km of a small car
 *  (fuel + wear, ACI tables ~0.15–0.25 €/km). A default, not a constraint. */
export const DEFAULT_CARRIER_RATE_EUR_PER_KM = 0.2;

/** Final clamp on the suggested carrier rate, €/km (MATCHING.md §4). */
export const CARRIER_RATE_MIN_EUR_PER_KM = 0.05;
export const CARRIER_RATE_MAX_EUR_PER_KM = 1.0;

/** Cold-start sender rate: 5 € per 100 km — the canonical example's price. */
export const DEFAULT_SENDER_RATE_EUR_PER_KM = 0.05;

/** Floor on the suggested sender offer: below this no journey is worth a
 *  single handoff (MATCHING.md §5). */
export const MIN_SUGGESTED_OFFER_EUR = 2;
