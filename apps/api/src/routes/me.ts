import { count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../app.js';
import { carrierTrips, hubs, shipments, users } from '@mercurio/db';
import { listQuery, MAX_STORAGE_DAYS } from '@mercurio/shared';
import { requireAuth } from '../plugins/auth-guard.js';
import { activateCarrierRole, deleteAccount, exportUserData, getRoles } from '../lib/account.js';
import { msat } from '../lib/serialize.js';

const hubBody = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(300),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  openingHours: z.record(z.string()),
  maxDimCmL: z.number().int().positive(),
  maxDimCmW: z.number().int().positive(),
  maxDimCmH: z.number().int().positive(),
  maxWeightG: z.number().int().positive(),
  acceptsUndeclared: z.boolean(),
  // Cap on hub fees (ECONOMICS.md sec.5, "tetto di validazione sulle fee hub"):
  // above this an hub is never worth the matching surplus for a carrier.
  feePercent: z.number().min(0).max(30),
  maxStorageDays: z.number().int().positive().max(MAX_STORAGE_DAYS), // ESCROW.md sec.4 CLTV budget (ADR-026)
  autoAccept: z.boolean().default(true),
});

export function registerMeRoutes(app: App) {
  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const [user] = await app.db.select().from(users).where(eq(users.id, request.userId!));
    if (!user) return reply.code(404).send({ error: 'not_found' });
    const roles = await getRoles(app.db, user.id);
    return {
      id: user.id,
      email: user.email,
      locale: user.locale,
      createdAt: user.createdAt,
      roles,
    };
  });

  app.post('/me/roles/carrier', { preHandler: requireAuth }, async (request) => {
    await activateCarrierRole(app.db, request.userId!);
    return { ok: true };
  });

  app.post(
    '/me/roles/hub',
    { schema: { body: hubBody }, preHandler: requireAuth },
    async (request, reply) => {
      const [existing] = await app.db
        .select({ id: hubs.id })
        .from(hubs)
        .where(eq(hubs.userId, request.userId!));
      if (existing) return reply.code(409).send({ error: 'hub_already_exists' });

      const b = request.body;
      const [hub] = await app.db
        .insert(hubs)
        .values({
          userId: request.userId!,
          name: b.name,
          address: b.address,
          lat: b.lat,
          lng: b.lng,
          openingHours: b.openingHours,
          maxDimCmL: b.maxDimCmL,
          maxDimCmW: b.maxDimCmW,
          maxDimCmH: b.maxDimCmH,
          maxWeightG: b.maxWeightG,
          acceptsUndeclared: b.acceptsUndeclared,
          feePercent: b.feePercent.toFixed(2),
          maxStorageDays: b.maxStorageDays,
          autoAccept: b.autoAccept,
          active: true,
        })
        .returning();
      return reply.code(201).send(hub);
    },
  );

  /** The sender's own shipments (ADR-018 §5): replaces the `localStorage`
   *  memory the web UI used before this endpoint existed. Newest first,
   *  simple offset pagination — a sender's own history is never large
   *  enough in the MVP to need a cursor. */
  app.get(
    '/me/shipments',
    { schema: { querystring: listQuery }, preHandler: requireAuth },
    async (request) => {
      const senderId = request.userId!;
      const { limit, offset } = request.query;

      const [rows, totalRows] = await Promise.all([
        app.db
          .select()
          .from(shipments)
          .where(eq(shipments.senderId, senderId))
          .orderBy(desc(shipments.createdAt))
          .limit(limit)
          .offset(offset),
        app.db.select({ value: count() }).from(shipments).where(eq(shipments.senderId, senderId)),
      ]);
      const total = totalRows[0]?.value ?? 0;

      const hubIds = new Set<string>();
      for (const s of rows) {
        hubIds.add(s.originHubId);
        hubIds.add(s.destHubId);
      }
      const hubRows =
        hubIds.size === 0
          ? []
          : await app.db
              .select({ id: hubs.id, name: hubs.name })
              .from(hubs)
              .where(inArray(hubs.id, [...hubIds]));
      const hubName = (id: string) => hubRows.find((h) => h.id === id)?.name ?? '—';

      return {
        items: rows.map((s) => ({
          id: s.id,
          codename: s.codename,
          status: s.status.toUpperCase(),
          originHubId: s.originHubId,
          originHubName: hubName(s.originHubId),
          destHubId: s.destHubId,
          destHubName: hubName(s.destHubId),
          offerMsat: msat(s.offerMsat),
          createdAt: s.createdAt.toISOString(),
        })),
        total,
        limit,
        offset,
      };
    },
  );

  /** The carrier's own declared trips (ADR-018 §5), newest declaration
   *  first. `status` mirrors the DB column as-is (MATCHING.md §1 / api.ts
   *  `meTripDto`): callers must additionally check `expiresAt` for
   *  "currently active", since no worker ever rewrites this column. */
  app.get(
    '/me/trips',
    { schema: { querystring: listQuery }, preHandler: requireAuth },
    async (request) => {
      const userId = request.userId!;
      const { limit, offset } = request.query;

      const [rows, totalRows] = await Promise.all([
        app.db
          .select()
          .from(carrierTrips)
          .where(eq(carrierTrips.userId, userId))
          .orderBy(desc(carrierTrips.createdAt))
          .limit(limit)
          .offset(offset),
        app.db
          .select({ value: count() })
          .from(carrierTrips)
          .where(eq(carrierTrips.userId, userId)),
      ]);
      const total = totalRows[0]?.value ?? 0;

      return {
        items: rows.map((t) => ({
          id: t.id,
          status: t.status,
          originLat: t.originLat,
          originLng: t.originLng,
          destLat: t.destLat,
          destLng: t.destLng,
          maxDeviationKm: t.maxDeviationKm,
          minRateMsatPerKm: msat(t.minRateMsatPerKm),
          departsAt: t.departsAt.toISOString(),
          expiresAt: t.expiresAt.toISOString(),
          createdAt: t.createdAt.toISOString(),
        })),
        total,
        limit,
        offset,
      };
    },
  );

  app.get('/me/export', { preHandler: requireAuth }, async (request) => {
    return exportUserData(app.db, request.userId!);
  });

  app.delete('/me', { preHandler: requireAuth }, async (request, reply) => {
    await deleteAccount(app.db, request.userId!, app.blobStore);
    reply.clearCookie('mercurio_session', { path: '/' });
    return { ok: true };
  });
}
