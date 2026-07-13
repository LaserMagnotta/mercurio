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
import { rankBoard, suggestCarrierRateEurPerKm, suggestSenderOfferEur } from '@mercurio/core';
import type { MatchingHub, ShipmentAtHub } from '@mercurio/shared';
import { createTripBody, hubFeePercentToBp, suggestedOfferQuery } from '@mercurio/shared';
import { z } from 'zod';
import type { App } from '../app';
import { requireAuth } from '../plugins/auth-guard';
import { loadShipmentBundle, remainingWorkPool } from '../shipments/context';
import { msat } from '../lib/serialize';
import { msatPerEur } from '../lib/eur-rate';

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
   *  actually accepted AND completed, each at its own frozen EUR rate. */
  app.get('/trips/suggested-rate', { preHandler: requireAuth }, async () => {
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
    return { eurPerKm };
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
      return { routeKm, suggestedEur };
    },
  );
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
    });
    return {
      shipmentId: c.shipmentId,
      isMatch: c.isMatch,
      bestDropHub: option(c.bestDropHub),
      alternatives: c.alternatives.map(option),
      currentHubId: meta.currentHubId,
      currentHubName: hubName(meta.currentHubId),
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
    };
  });
}
