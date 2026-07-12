import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../app';
import { hubs, users } from '@mercurio/db';
import { requireAuth } from '../plugins/auth-guard';
import { activateCarrierRole, deleteAccount, exportUserData, getRoles } from '../lib/account';

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
  maxStorageHours: z.number().int().positive().max(168), // ESCROW.md sec.4 CLTV budget
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
          maxStorageHours: b.maxStorageHours,
          autoAccept: b.autoAccept,
          active: true,
        })
        .returning();
      return reply.code(201).send(hub);
    },
  );

  app.get('/me/export', { preHandler: requireAuth }, async (request) => {
    return exportUserData(app.db, request.userId!);
  });

  app.delete('/me', { preHandler: requireAuth }, async (request, reply) => {
    await deleteAccount(app.db, request.userId!);
    reply.clearCookie('mercurio_session', { path: '/' });
    return { ok: true };
  });
}
