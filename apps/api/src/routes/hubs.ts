// Hub discovery and the hub owner's deposit-request dashboard
// (ARCHITECTURE.md §4, CLAUDE.md "Hub — dettagli").

import { and, eq, inArray } from 'drizzle-orm';
import { hubs, hubStays, shipments, walletConnections } from '@mercurio/db';
import type { App } from '../app';
import { requireAuth } from '../plugins/auth-guard';
import { msat } from '../lib/serialize';

export function registerHubRoutes(app: App) {
  /** Public list of active hubs — the sender picks origin/destination here. */
  app.get('/hubs', async () => {
    const rows = await app.db.select().from(hubs).where(eq(hubs.active, true));
    const owners = rows.map((h) => h.userId);
    const connected = new Set(
      owners.length === 0
        ? []
        : (
            await app.db
              .select({ userId: walletConnections.userId })
              .from(walletConnections)
              .where(
                and(
                  inArray(walletConnections.userId, owners),
                  eq(walletConnections.status, 'connected'),
                ),
              )
          ).map((r) => r.userId),
    );
    return {
      hubs: rows.map((h) => ({
        id: h.id,
        name: h.name,
        address: h.address,
        lat: h.lat,
        lng: h.lng,
        feePercent: h.feePercent,
        maxDims: { lengthCm: h.maxDimCmL, widthCm: h.maxDimCmW, heightCm: h.maxDimCmH },
        maxWeightG: h.maxWeightG,
        acceptsUndeclared: h.acceptsUndeclared,
        maxStorageHours: h.maxStorageHours,
        autoAccept: h.autoAccept,
        walletConnected: connected.has(h.userId),
      })),
    };
  });

  /** The hub owner's dashboard: shipments waiting for this hub's acceptance
   *  (manual hubs) and every stay currently reserved or hosted here. */
  app.get('/hubs/mine/requests', { preHandler: requireAuth }, async (request, reply) => {
    const [hub] = await app.db.select().from(hubs).where(eq(hubs.userId, request.userId!));
    if (!hub) return reply.code(404).send({ error: 'not_a_hub' });

    const [pendingAccept, stays] = await Promise.all([
      app.db
        .select()
        .from(shipments)
        .where(and(eq(shipments.originHubId, hub.id), eq(shipments.status, 'draft'))),
      app.db
        .select({ stay: hubStays, shipment: shipments })
        .from(hubStays)
        .innerJoin(shipments, eq(shipments.id, hubStays.shipmentId))
        .where(
          and(eq(hubStays.hubId, hub.id), inArray(hubStays.status, ['reserved', 'active'])),
        ),
    ]);

    return {
      hubId: hub.id,
      acceptRequests: pendingAccept.map((s) => ({
        shipmentId: s.id,
        destHubId: s.destHubId,
        dims: { lengthCm: s.dimLCm, widthCm: s.dimWCm, heightCm: s.dimHCm },
        weightG: s.weightG,
        undeclared: s.undeclared,
        custodyBondMsat: msat(s.custodyBondMsat),
        maxStorageHours: s.maxStorageHours,
        createdAt: s.createdAt.toISOString(),
      })),
      stays: stays.map(({ stay, shipment }) => ({
        hubStayId: stay.id,
        shipmentId: stay.shipmentId,
        status: stay.status,
        shipmentStatus: shipment.status,
        storageDeadlineAt: stay.storageDeadlineAt?.toISOString() ?? null,
        custodyBondMsat: msat(shipment.custodyBondMsat),
      })),
    };
  });
}
