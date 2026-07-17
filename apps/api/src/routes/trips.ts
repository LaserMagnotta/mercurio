// Carrier trips and the ranked board (MATCHING.md). The carrier declares the
// REAL journey first; the board is computed against it with the same pure
// engine (rankBoard) whose numbers are exactly the msat a leg_accept would
// freeze — no surprises after.

import { randomUUID } from 'node:crypto';
import { and, eq, gt, inArray } from 'drizzle-orm';
import {
  carrierProfiles,
  carrierTrips,
  hubs,
  hubStays,
  legs,
  rateObservations,
  shipmentClaims,
  shipments,
  walletConnections,
} from '@mercurio/db';
import {
  orderRouteWaypoints,
  rankBoard,
  suggestCarrierRateEurPerKm,
  suggestSenderOfferEur,
} from '@mercurio/core';
import type { GeoPoint, MatchingHub, RouteStop, ShipmentAtHub } from '@mercurio/shared';
import {
  createTripBody,
  hubFeePercentToBp,
  MAX_ROUTE_WAYPOINTS,
  suggestedOfferQuery,
  tripRouteQuery,
} from '@mercurio/shared';
import { z } from 'zod';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { loadShipmentBundle, remainingWorkPool } from '../shipments/context.js';
import { msat } from '../lib/serialize.js';
import { eurFloatToMsat, msatPerEur, type EurRateSnapshot } from '../lib/eur-rate.js';
import { loadRatings, ratingOf, type RatingSubject } from '../lib/reviews.js';
import { replyLifecycleError } from './lifecycle-errors.js';

const tripParams = z.object({ id: z.string().uuid() });

const DEFAULT_TRIP_TTL_HOURS = 24;

export function registerTripRoutes(app: App) {
  app.post(
    '/trips',
    { schema: { body: createTripBody }, preHandler: requireAuth },
    async (request, reply) => {
      const [profile] = await app.db
        .select()
        .from(carrierProfiles)
        .where(eq(carrierProfiles.userId, request.userId!));
      if (!profile) {
        return reply
          .code(403)
          .send({ error: 'carrier_role_required', message: 'activate the carrier role first' });
      }
      const b = request.body;
      const now = app.lifecycle.now();
      const departsAt = b.departsAt ? new Date(b.departsAt) : now;
      const expiresAt = b.expiresAt
        ? new Date(b.expiresAt)
        : new Date(departsAt.getTime() + DEFAULT_TRIP_TTL_HOURS * 60 * 60 * 1000);
      if (expiresAt.getTime() <= departsAt.getTime()) {
        return reply.code(422).send({ error: 'trip_expires_before_departure' });
      }
      const [trip] = await app.db
        .insert(carrierTrips)
        .values({
          userId: request.userId!,
          originLat: b.originLat,
          originLng: b.originLng,
          destLat: b.destLat,
          destLng: b.destLng,
          departsAt,
          expiresAt,
          maxDeviationKm: b.maxDeviationKm,
          minRateMsatPerKm: BigInt(b.minRateMsatPerKm),
          status: 'active',
        })
        .returning();
      return reply.code(201).send({
        id: trip!.id,
        maxDeviationKm: trip!.maxDeviationKm,
        minRateMsatPerKm: msat(trip!.minRateMsatPerKm),
        departsAt: trip!.departsAt.toISOString(),
        expiresAt: trip!.expiresAt.toISOString(),
      });
    },
  );

  /** Suggested min rate €/km of detour (MATCHING.md §4): p25 of what carriers
   *  actually accepted AND completed, each at its own frozen EUR rate. The
   *  msat equivalent is computed HERE (current snapshot, floor-to-sat): the
   *  client prefills a sats-first input and never converts money itself. */
  app.get('/trips/suggested-rate', { preHandler: requireAuth }, async (_request, reply) => {
    const rows = await app.db
      .select({ obs: rateObservations, eurRate: shipments.eurRateSnapshot })
      .from(rateObservations)
      .innerJoin(legs, eq(legs.id, rateObservations.legId))
      .innerJoin(shipments, eq(shipments.id, legs.shipmentId));
    const eurPerKm = suggestCarrierRateEurPerKm(
      rows.map(({ obs, eurRate }) => ({
        netMsat: obs.netMsat,
        detourKm: obs.detourKm,
        msatPerEur: msatPerEur(eurRate),
        acceptedAt: obs.acceptedAt,
      })),
      app.lifecycle.now(),
    );
    // `suggest`: this only prefills an input the carrier can overwrite, so any
    // cached rate does (ADR-025 §5). It fails only if there has never been one.
    let rate: EurRateSnapshot;
    try {
      rate = await app.eurRate.snapshot('suggest');
    } catch (err) {
      if (await replyLifecycleError(reply, err)) return;
      throw err;
    }
    return {
      eurPerKm,
      msatPerKm: msat(eurFloatToMsat(eurPerKm, rate.satsPerEur)),
      eurRate: { satsPerEur: rate.satsPerEur, source: rate.source, at: rate.at.toISOString() },
    };
  });

  /** The ranked board for a declared trip (MATCHING.md §3). */
  app.get(
    '/trips/:id/board',
    { schema: { params: tripParams }, preHandler: requireAuth },
    async (request, reply) => {
      const [trip] = await app.db
        .select()
        .from(carrierTrips)
        .where(eq(carrierTrips.id, request.params.id));
      if (!trip || trip.userId !== request.userId) {
        return reply.code(404).send({ error: 'trip_not_found' });
      }
      const now = app.lifecycle.now();
      if (trip.status !== 'active' || trip.expiresAt.getTime() <= now.getTime()) {
        return reply.code(409).send({ error: 'trip_not_active' });
      }

      const board = await buildBoard(app, trip, request.userId!);
      return { tripId: trip.id, cards: board };
    },
  );

  /** The trip route view, data part of ADR-015 (the Leaflet map itself is
   *  the web UI's job): stops of the accepted legs — plus one optional board
   *  preview — in the computed visit order, and the Google Maps deep link. */
  app.get(
    '/trips/:id/route',
    { schema: { params: tripParams, querystring: tripRouteQuery }, preHandler: requireAuth },
    async (request, reply) => {
      const [trip] = await app.db
        .select()
        .from(carrierTrips)
        .where(eq(carrierTrips.id, request.params.id));
      if (!trip || trip.userId !== request.userId) {
        return reply.code(404).send({ error: 'trip_not_found' });
      }
      // No status gate, unlike the board: the route view is read-only and a
      // carrier mid-journey still needs the map after the trip row expires.

      // Accepted legs of this trip that still have stops ahead. A picked_up
      // leg contributes only its drop (the pickup already happened).
      const legRows = (
        await app.db
          .select()
          .from(legs)
          .where(
            and(
              eq(legs.tripId, trip.id),
              inArray(legs.status, ['pending_funding', 'booked', 'picked_up']),
            ),
          )
      ).sort((a, b) => a.acceptedAt.getTime() - b.acceptedAt.getTime());

      const hubIds = new Set<string>();
      for (const leg of legRows) {
        hubIds.add(leg.fromHubId);
        hubIds.add(leg.toHubId);
      }

      // Optional board preview: the shipment's current hub as pickup, the
      // card's chosen drop hub as drop. Light validation only — this draws a
      // line on a map, it books nothing.
      const { previewShipmentId, previewDropHubId } = request.query;
      if ((previewShipmentId === undefined) !== (previewDropHubId === undefined)) {
        return reply.code(400).send({ error: 'preview_pair_required' });
      }
      let previewPickupHubId: string | null = null;
      if (previewShipmentId) {
        const bundle = await loadShipmentBundle(app.db, previewShipmentId);
        if (!bundle) return reply.code(404).send({ error: 'shipment_not_found' });
        if (bundle.state !== 'AT_HUB' || !bundle.currentStayRow) {
          return reply.code(409).send({ error: 'not_at_hub' });
        }
        previewPickupHubId = bundle.currentStayRow.hubId;
        hubIds.add(previewPickupHubId);
        hubIds.add(previewDropHubId!);
      }

      const hubRows =
        hubIds.size === 0
          ? []
          : await app.db.select().from(hubs).where(inArray(hubs.id, [...hubIds]));
      const hubById = new Map(hubRows.map((h) => [h.id, h]));
      if (previewDropHubId && !hubById.get(previewDropHubId)?.active) {
        return reply.code(404).send({ error: 'hub_not_found' });
      }

      // Stops grouped per shipment (a pickup is never routed without its
      // drop), legs in acceptance order, the preview last: when the total
      // exceeds MAX_ROUTE_WAYPOINTS whole trailing groups go unrouted and
      // the UI lists them instead (ADR-015).
      const mustHub = (id: string) => {
        const hub = hubById.get(id);
        if (!hub) throw new Error(`trip ${trip.id} references missing hub ${id}`);
        return hub;
      };
      const toStop = (
        hubId: string,
        kind: RouteStop['kind'],
        shipmentId: string,
        legId: string | null,
        preview: boolean,
      ) => {
        const hub = mustHub(hubId);
        return {
          hubId,
          point: { lat: hub.lat, lng: hub.lng },
          kind,
          shipmentId,
          hubName: hub.name,
          legId,
          preview,
        };
      };
      type StopWithMeta = ReturnType<typeof toStop>;
      const groups: StopWithMeta[][] = legRows.map((leg) =>
        leg.status === 'picked_up'
          ? [toStop(leg.toHubId, 'drop', leg.shipmentId, leg.id, false)]
          : [
              toStop(leg.fromHubId, 'pickup', leg.shipmentId, leg.id, false),
              toStop(leg.toHubId, 'drop', leg.shipmentId, leg.id, false),
            ],
      );
      if (previewShipmentId && previewPickupHubId) {
        groups.push([
          toStop(previewPickupHubId, 'pickup', previewShipmentId, null, true),
          toStop(previewDropHubId!, 'drop', previewShipmentId, null, true),
        ]);
      }
      const routable: StopWithMeta[] = [];
      const unrouted: StopWithMeta[] = [];
      for (const group of groups) {
        if (routable.length + group.length <= MAX_ROUTE_WAYPOINTS) routable.push(...group);
        else unrouted.push(...group);
      }

      const origin: GeoPoint = { lat: trip.originLat, lng: trip.originLng };
      const destination: GeoPoint = { lat: trip.destLat, lng: trip.destLng };
      // orderRouteWaypoints reorders the very objects it receives, so the
      // metadata riding on each stop survives the cast back.
      const ordered = orderRouteWaypoints(
        origin,
        destination,
        routable,
        app.lifecycle.distance,
      ) as StopWithMeta[];

      const stopDto = (s: StopWithMeta) => ({
        hubId: s.hubId,
        hubName: s.hubName,
        lat: s.point.lat,
        lng: s.point.lng,
        kind: s.kind,
        shipmentId: s.shipmentId,
        legId: s.legId,
        preview: s.preview,
      });
      return {
        tripId: trip.id,
        origin,
        destination,
        stops: ordered.map(stopDto),
        unroutedStops: unrouted.map(stopDto),
        googleMapsUrl: googleMapsDirectionsUrl(origin, destination, ordered),
      };
    },
  );

  /** Suggested sender offer for a route (MATCHING.md §5): what historically
   *  DELIVERED, never the low anchor. */
  app.get(
    '/shipments/suggested-offer',
    { schema: { querystring: suggestedOfferQuery }, preHandler: requireAuth },
    async (request, reply) => {
      const { originHubId, destHubId } = request.query;
      const hubRows = await app.db
        .select()
        .from(hubs)
        .where(inArray(hubs.id, [originHubId, destHubId]));
      const origin = hubRows.find((h) => h.id === originHubId);
      const dest = hubRows.find((h) => h.id === destHubId);
      if (!origin || !dest) return reply.code(404).send({ error: 'hub_not_found' });
      const routeKm = app.lifecycle.distance.distanceKm(
        { lat: origin.lat, lng: origin.lng },
        { lat: dest.lat, lng: dest.lng },
      );
      if (routeKm <= 0) return reply.code(422).send({ error: 'hubs_too_close' });
      // Delivered shipments only, dated by their recipient_pickup event.
      const delivered = await app.db
        .select()
        .from(shipments)
        .where(eq(shipments.status, 'delivered'));
      const suggestedEur = suggestSenderOfferEur(
        routeKm,
        delivered.map((s) => ({
          offerMsat: s.offerMsat,
          totalKm: s.distanceKm,
          msatPerEur: msatPerEur(s.eurRateSnapshot),
          deliveredAt: s.createdAt,
        })),
        app.lifecycle.now(),
      );
      // msat equivalent computed server-side (current snapshot, floor-to-sat):
      // the client shows EUR and prefills sats, it never converts money.
      // `suggest`: a hint, not a contract — any cached rate does (ADR-025 §5).
      let rate: EurRateSnapshot;
      try {
        rate = await app.eurRate.snapshot('suggest');
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return {
        routeKm,
        suggestedEur,
        suggestedMsat: msat(eurFloatToMsat(suggestedEur, rate.satsPerEur)),
        eurRate: { satsPerEur: rate.satsPerEur, source: rate.source, at: rate.at.toISOString() },
      };
    },
  );
}

/**
 * The "Apri in Google Maps" deep link (ADR-015): one URL, no API, waypoints
 * in OUR computed order — Google optimizes the road on each hop but never
 * reorders the stops, so the pickup-before-drop constraint survives. Nothing
 * reaches Google until the carrier actually taps the button.
 */
function googleMapsDirectionsUrl(
  origin: GeoPoint,
  destination: GeoPoint,
  stops: readonly { point: GeoPoint }[],
): string {
  const coord = (p: GeoPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const waypoints: string[] = [];
  for (const stop of stops) {
    const w = coord(stop.point);
    // Consecutive stops at the same hub (drop + pickup) are one waypoint.
    if (waypoints.at(-1) !== w) waypoints.push(w);
  }
  const params = new URLSearchParams({
    api: '1',
    origin: coord(origin),
    destination: coord(destination),
    travelmode: 'driving',
  });
  if (waypoints.length > 0) params.set('waypoints', waypoints.join('|'));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

async function buildBoard(app: App, trip: typeof carrierTrips.$inferSelect, carrierId: string) {
  const db = app.db;
  const provider = app.lifecycle.distance;

  // Shipments idle AT_HUB with no leg in flight (another leg_accept would be
  // rejected by the machine) and not the carrier's own (a self-payment hold
  // is impossible on Lightning — payer and payee must differ).
  const atHub = await db
    .select({ shipment: shipments, stay: hubStays })
    .from(shipments)
    .innerJoin(
      hubStays,
      and(eq(hubStays.shipmentId, shipments.id), eq(hubStays.status, 'active')),
    )
    .where(eq(shipments.status, 'at_hub'));

  const atHubIds = atHub.map((r) => r.shipment.id);
  const busy = new Set(
    atHubIds.length === 0
      ? []
      : (
          await db
            .select({ shipmentId: legs.shipmentId })
            .from(legs)
            .where(
              and(
                inArray(legs.shipmentId, atHubIds),
                inArray(legs.status, ['pending_funding', 'booked', 'picked_up']),
              ),
            )
        ).map((r) => r.shipmentId),
  );
  // A shipment with a live recipient claim leaves the board from the very
  // request (ADR-016): a carrier accepting it would be rejected anyway.
  if (atHubIds.length > 0) {
    const claimed = await db
      .select({ shipmentId: shipmentClaims.shipmentId })
      .from(shipmentClaims)
      .where(
        and(
          inArray(shipmentClaims.shipmentId, atHubIds),
          inArray(shipmentClaims.status, ['pending_funding', 'funded']),
        ),
      );
    for (const row of claimed) busy.add(row.shipmentId);
  }

  const hubRows = await db.select().from(hubs).where(eq(hubs.active, true));
  const hubById = new Map(hubRows.map((h) => [h.id, h]));
  const walletOwners = new Set(
    hubRows.length === 0
      ? []
      : (
          await db
            .select({ userId: walletConnections.userId })
            .from(walletConnections)
            .where(
              and(
                inArray(
                  walletConnections.userId,
                  hubRows.map((h) => h.userId),
                ),
                eq(walletConnections.status, 'connected'),
              ),
            )
        ).map((r) => r.userId),
  );

  // The carrier's own hub can never be a drop candidate: the arrival fee and
  // bond would be self-payments.
  const matchingHubs: MatchingHub[] = hubRows
    .filter((h) => h.userId !== carrierId)
    .map((h) => ({
      hubId: h.id,
      location: { lat: h.lat, lng: h.lng },
      active: h.active,
      feeBp: hubFeePercentToBp(h.feePercent),
      maxDimsCm: { lengthCm: h.maxDimCmL, widthCm: h.maxDimCmW, heightCm: h.maxDimCmH },
      maxWeightG: h.maxWeightG,
      acceptsUndeclared: h.acceptsUndeclared,
      walletConnected: walletOwners.has(h.userId),
      autoAcceptDeposits: h.autoAccept,
    }));

  const shipmentsAtHub: ShipmentAtHub[] = [];
  const cardMeta = new Map<
    string,
    { currentHubId: string; remainingKm: number; row: typeof shipments.$inferSelect }
  >();
  for (const { shipment, stay } of atHub) {
    if (busy.has(shipment.id)) continue;
    if (shipment.senderId === carrierId) continue;
    const currentHub = hubById.get(stay.hubId);
    const destHub = hubById.get(shipment.destHubId);
    if (!currentHub || !destHub) continue;
    const bundle = await loadShipmentBundle(db, shipment.id);
    if (!bundle) continue;
    const remainingKm = provider.distanceKm(
      { lat: currentHub.lat, lng: currentHub.lng },
      { lat: destHub.lat, lng: destHub.lng },
    );
    if (!(remainingKm > 0)) continue;
    shipmentsAtHub.push({
      shipmentId: shipment.id,
      currentHubId: stay.hubId,
      destHubId: shipment.destHubId,
      poolMsat: remainingWorkPool(bundle, remainingKm),
      carrierBonusMsat: bundle.carrierBonusAvailableMsat,
      totalKm: shipment.distanceKm,
      remainingKm,
      dimsCm: { lengthCm: shipment.dimLCm, widthCm: shipment.dimWCm, heightCm: shipment.dimHCm },
      weightG: shipment.weightG,
      undeclared: shipment.undeclared,
    });
    cardMeta.set(shipment.id, { currentHubId: stay.hubId, remainingKm, row: shipment });
  }

  const candidates = rankBoard(
    {
      origin: { lat: trip.originLat, lng: trip.originLng },
      destination: { lat: trip.destLat, lng: trip.destLng },
      maxDeviationKm: trip.maxDeviationKm,
      minRateMsatPerKm: trip.minRateMsatPerKm,
    },
    shipmentsAtHub,
    matchingHubs,
    provider,
  );

  // Ratings shown on every card (MATCHING.md §3): the sender's and those of
  // every hub involved — current hub plus each proposed drop. One grouped
  // query for the whole board, computed from the reviews table on read.
  const ratingSubjects: RatingSubject[] = [];
  for (const c of candidates) {
    const meta = cardMeta.get(c.shipmentId)!;
    ratingSubjects.push({ userId: meta.row.senderId, role: 'sender' });
    for (const hubId of [
      meta.currentHubId,
      c.bestDropHub.hubId,
      ...c.alternatives.map((o) => o.hubId),
    ]) {
      const owner = hubById.get(hubId)?.userId;
      if (owner) ratingSubjects.push({ userId: owner, role: 'hub' });
    }
  }
  const ratings = await loadRatings(db, ratingSubjects);
  const hubRating = (hubId: string) => ratingOf(ratings, hubById.get(hubId)?.userId ?? '', 'hub');

  const hubName = (id: string) => hubById.get(id)?.name ?? id;
  return candidates.map((c) => {
    const meta = cardMeta.get(c.shipmentId)!;
    const option = (o: (typeof c)['bestDropHub']) => ({
      hubId: o.hubId,
      hubName: hubName(o.hubId),
      detourKm: o.detourKm,
      netMsat: msat(o.netMsat),
      finalizationBonusMsat: msat(o.finalizationBonusMsat),
      surplusMsat: msat(o.surplusMsat),
      hubRating: hubRating(o.hubId),
    });
    return {
      shipmentId: c.shipmentId,
      codename: meta.row.codename,
      isMatch: c.isMatch,
      bestDropHub: option(c.bestDropHub),
      alternatives: c.alternatives.map(option),
      currentHubId: meta.currentHubId,
      currentHubName: hubName(meta.currentHubId),
      senderRating: ratingOf(ratings, meta.row.senderId, 'sender'),
      currentHubRating: hubRating(meta.currentHubId),
      destHubId: meta.row.destHubId,
      remainingKm: meta.remainingKm,
      totalKm: meta.row.distanceKm,
      custodyBondMsat: msat(meta.row.custodyBondMsat),
      dims: {
        lengthCm: meta.row.dimLCm,
        widthCm: meta.row.dimWCm,
        heightCm: meta.row.dimHCm,
      },
      weightG: meta.row.weightG,
      undeclared: meta.row.undeclared,
      // The shipment's FROZEN snapshot (ADR-008): the card's indicative €
      // must use the same rate that will govern the carrier's payout.
      eurRate: {
        satsPerEur: meta.row.eurRateSnapshot,
        source: meta.row.eurRateSource,
        at: meta.row.eurRateAt.toISOString(),
      },
    };
  });
}
