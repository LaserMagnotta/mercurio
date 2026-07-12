// Carrier ↔ shipment board ranking (MATCHING.md §2–3). Pure functions, no I/O.
//
// For every shipment sitting AT_HUB the engine evaluates each hub H as a drop
// candidate, prices the leg S→H with the economics engine (so board numbers
// are EXACTLY the msat that would be frozen at acceptance — no surprises
// after), and proposes H* = argmax surplus among candidates within dev_max.
//
// Distances arrive as float km from the DistanceProvider and are quantized to
// integer meters before any money math, mirroring the economics engine: two
// machines ranking the same board see the same msat.

import type {
  CarrierTrip,
  DimensionsCm,
  DropHubOption,
  LegPricing,
  MatchCandidate,
  MatchingHub,
  ShipmentAtHub,
} from '@mercurio/shared';
import { MAX_ALTERNATIVE_DROP_HUBS, MIN_LEG_PROGRESS_KM } from '@mercurio/shared';
import { EconomicsError, priceLeg } from '../economics/economics';
import type { DistanceProvider } from './distance';

const kmToMeters = (km: number): number => Math.round(km * 1000);

/** Does the parcel fit the hub's size limits? Rotation is allowed (a box can
 *  be turned on its side), so compare the sorted triples. */
function fitsDims(parcel: DimensionsCm, limit: DimensionsCm): boolean {
  const p = [parcel.lengthCm, parcel.widthCm, parcel.heightCm].sort((x, y) => x - y);
  const l = [limit.lengthCm, limit.widthCm, limit.heightCm].sort((x, y) => x - y);
  return p.every((side, i) => side <= (l[i] ?? 0));
}

/** Candidate conditions 1 and 3 of MATCHING.md §2: the hub is active, takes
 *  this parcel physically, and can bind its custody bond unattended. */
function hubAcceptsParcel(hub: MatchingHub, shipment: ShipmentAtHub): boolean {
  return (
    hub.active &&
    hub.walletConnected &&
    hub.autoAcceptDeposits &&
    shipment.weightG <= hub.maxWeightG &&
    fitsDims(shipment.dimsCm, hub.maxDimsCm) &&
    (!shipment.undeclared || hub.acceptsUndeclared)
  );
}

/** Deterministic option order: surplus desc, then detour asc, then hubId —
 *  ties must not depend on input array order (property-tested). */
function compareOptions(a: DropHubOption, b: DropHubOption): number {
  if (a.surplusMsat !== b.surplusMsat) return b.surplusMsat > a.surplusMsat ? 1 : -1;
  if (a.detourKm !== b.detourKm) return a.detourKm - b.detourKm;
  return a.hubId < b.hubId ? -1 : a.hubId > b.hubId ? 1 : 0;
}

/** Board order (MATCHING.md §3): matches first, surplus(H*) desc within each
 *  section, shipmentId as the deterministic tiebreaker. */
function compareCandidates(a: MatchCandidate, b: MatchCandidate): number {
  if (a.isMatch !== b.isMatch) return a.isMatch ? -1 : 1;
  if (a.bestDropHub.surplusMsat !== b.bestDropHub.surplusMsat) {
    return b.bestDropHub.surplusMsat > a.bestDropHub.surplusMsat ? 1 : -1;
  }
  return a.shipmentId < b.shipmentId ? -1 : a.shipmentId > b.shipmentId ? 1 : 0;
}

function evaluateShipment(
  trip: CarrierTrip,
  shipment: ShipmentAtHub,
  hubs: readonly MatchingHub[],
  hubById: ReadonlyMap<string, MatchingHub>,
  distance: DistanceProvider,
  directKm: number,
  maxDeviationM: number,
): MatchCandidate | null {
  const currentHub = hubById.get(shipment.currentHubId);
  const destHub = hubById.get(shipment.destHubId);
  // Defensive skips, not throws: one malformed row must not take down the
  // whole board. The API logs skipped shipments through its own validation.
  if (!currentHub || !destHub) return null;
  const totalM = kmToMeters(shipment.totalKm);
  const remainingM = kmToMeters(shipment.remainingKm);
  if (
    !Number.isFinite(shipment.totalKm) ||
    !Number.isFinite(shipment.remainingKm) ||
    remainingM <= 0 ||
    remainingM > totalM ||
    shipment.poolMsat < 0n
  ) {
    return null;
  }

  const originToCurrentKm = distance.distanceKm(trip.origin, currentHub.location);
  const options: DropHubOption[] = [];
  for (const hub of hubs) {
    if (!hubAcceptsParcel(hub, shipment)) continue;
    const isDestination = hub.hubId === shipment.destHubId;
    const hubToDestM = isDestination
      ? 0
      : kmToMeters(distance.distanceKm(hub.location, destHub.location));
    const progressM = remainingM - hubToDestM;
    // Positive, non-trivial progress: r_S − d(H,T) ≥ max(5 km, 5% × D). The
    // integer comparisons mirror priceLeg's guard exactly, so pricing below
    // can never reject a hub this filter admitted. Delivering to the final
    // destination is always admissible, however short the hop (ECONOMICS §6).
    if (progressM <= 0) continue;
    if (!isDestination && (progressM < MIN_LEG_PROGRESS_KM * 1000 || progressM * 20 < totalM))
      continue;

    let pricing: LegPricing;
    try {
      pricing = priceLeg({
        poolMsat: shipment.poolMsat,
        totalKm: shipment.totalKm,
        remainingKm: shipment.remainingKm,
        progressKm: progressM / 1000,
        depHubFeeBp: currentHub.feeBp,
        arrHubFeeBp: hub.feeBp,
      });
    } catch (error) {
      // e.g. a fee above the validation cap: the hub disqualifies itself
      // from this leg instead of poisoning the whole board.
      if (error instanceof EconomicsError) continue;
      throw error;
    }

    const detourKm =
      originToCurrentKm +
      distance.distanceKm(currentHub.location, hub.location) +
      distance.distanceKm(hub.location, trip.destination) -
      directKm;
    if (!Number.isFinite(detourKm)) continue;
    // The metric satisfies the triangle inequality, so detour ≥ 0 up to float
    // noise; clamp so an injected test provider can't produce a negative cost.
    const detourM = Math.max(0, kmToMeters(detourKm));
    // Threshold cost rate_min × detour in exact integer math (msat/km ×
    // meters / 1000). Integer division floors the threshold, in the
    // carrier's favor by < 1 msat.
    const thresholdMsat = (trip.minRateMsatPerKm * BigInt(detourM)) / 1000n;
    options.push({
      hubId: hub.hubId,
      detourKm: detourM / 1000,
      netMsat: pricing.netMsat,
      surplusMsat: pricing.netMsat - thresholdMsat,
    });
  }
  if (options.length === 0) return null;

  // H* is picked among candidates within dev_max; when none qualifies the
  // card still needs a proposal, so fall back to the best over all candidates
  // (isMatch stays false — the carrier sees exactly what accepting would cost).
  const withinDevMax = options.filter((o) => kmToMeters(o.detourKm) <= maxDeviationM);
  const pool = (withinDevMax.length > 0 ? withinDevMax : options).sort(compareOptions);
  const best = pool[0];
  if (!best) return null; // unreachable: pool is non-empty by construction
  return {
    shipmentId: shipment.shipmentId,
    bestDropHub: best,
    alternatives: pool.slice(1, 1 + MAX_ALTERNATIVE_DROP_HUBS),
    isMatch: withinDevMax.length > 0 && best.surplusMsat >= 0n,
  };
}

/**
 * Rank the board for a declared trip (MATCHING.md §3).
 *
 * Returns one MatchCandidate per rankable shipment: matches first ("Per te"),
 * then the rest ("Altre"), both surplus-descending — a negative surplus reads
 * as "how far from being worth it". Shipments whose route hubs are missing
 * from `hubs` or that admit no drop candidate at all are omitted: there is
 * nothing meaningful to put on their card.
 *
 * O(shipments × hubs) by design — fine at MVP volumes (MATCHING.md §3).
 */
export function rankBoard(
  trip: CarrierTrip,
  shipments: readonly ShipmentAtHub[],
  hubs: readonly MatchingHub[],
  distance: DistanceProvider,
): MatchCandidate[] {
  if (!Number.isFinite(trip.maxDeviationKm) || trip.maxDeviationKm < 0) {
    throw new RangeError(
      `maxDeviationKm must be a finite km value >= 0, got ${trip.maxDeviationKm}`,
    );
  }
  if (trip.minRateMsatPerKm < 0n) {
    throw new RangeError(`minRateMsatPerKm must be >= 0 msat/km, got ${trip.minRateMsatPerKm}`);
  }
  const hubById = new Map(hubs.map((hub) => [hub.hubId, hub]));
  const maxDeviationM = kmToMeters(trip.maxDeviationKm);
  const directKm = distance.distanceKm(trip.origin, trip.destination);

  const candidates: MatchCandidate[] = [];
  for (const shipment of shipments) {
    const candidate = evaluateShipment(
      trip,
      shipment,
      hubs,
      hubById,
      distance,
      directKm,
      maxDeviationM,
    );
    if (candidate) candidates.push(candidate);
  }
  return candidates.sort(compareCandidates);
}
