// Wallet connection endpoints (ADR-013): every money-bearing role — sender,
// carrier, hub — must connect their OWN wallet before the protocol lets them
// commit to anything. The platform stores an encrypted connection secret; it
// can ask the wallet to act, never dispose of its funds (ESCROW.md §6).

import { and, desc, eq } from 'drizzle-orm';
import { walletConnections } from '@mercurio/db';
import { connectWalletBody } from '@mercurio/shared';
import { NwcProbeError, NwcUriError, probeNwcWallet } from '@mercurio/escrow';
import type { App } from '../app';
import { requireAuth } from '../plugins/auth-guard';
import { sealSecret } from '../lib/secret-box';

export function registerWalletRoutes(app: App) {
  app.post(
    '/me/wallet',
    { schema: { body: connectWalletBody }, preHandler: requireAuth },
    async (request, reply) => {
      const { kind, connectionSecret } = request.body;
      if (kind === 'fake' && !app.lifecycleConfig.fakeWalletsEnabled) {
        return reply
          .code(400)
          .send({ error: 'fake_wallets_disabled', message: 'fake wallets are dev/test only' });
      }

      // ADR-019: validate the connection string and probe capabilities BEFORE
      // touching any existing connection — a failed attempt to add a new NWC
      // wallet must never disconnect a working one.
      let capabilities: Record<string, unknown> = { holdInvoice: true };
      if (kind === 'nwc') {
        try {
          const probe = await probeNwcWallet(connectionSecret, {
            ...(app.lifecycleConfig.nwcTransportFactory && {
              transportFactory: app.lifecycleConfig.nwcTransportFactory,
            }),
            ...(app.lifecycleConfig.nwcProbeTimeoutMs !== undefined && {
              timeoutMs: app.lifecycleConfig.nwcProbeTimeoutMs,
            }),
          });
          if (!probe.baseline) {
            return reply.code(400).send({
              error: 'nwc_missing_required_methods',
              message:
                'This wallet is missing pay_invoice/make_invoice/lookup_invoice — it cannot be used with Mercurio at all',
            });
          }
          capabilities = { holdInvoice: probe.holdInvoice, encryption: probe.encryption };
        } catch (err) {
          if (err instanceof NwcUriError) {
            return reply
              .code(400)
              .send({ error: 'nwc_invalid_connection_string', message: err.message });
          }
          const message = err instanceof NwcProbeError ? err.message : 'could not reach the wallet';
          return reply.code(400).send({ error: 'nwc_connection_failed', message });
        }
      }

      // One active connection per user: connecting a new wallet supersedes
      // the previous one (holds already in flight are unaffected — they live
      // in the wallets themselves, not here).
      const [row] = await app.db.transaction(async (tx) => {
        await tx
          .update(walletConnections)
          .set({ status: 'disconnected' })
          .where(eq(walletConnections.userId, request.userId!));
        return tx
          .insert(walletConnections)
          .values({
            userId: request.userId!,
            kind,
            connectionSecretEncrypted: sealSecret(connectionSecret, app.lifecycleConfig.secretKey),
            capabilities,
            status: 'connected',
          })
          .returning();
      });
      return reply.code(201).send({ id: row!.id, kind: row!.kind, status: row!.status });
    },
  );

  app.get('/me/wallet', { preHandler: requireAuth }, async (request) => {
    const [row] = await app.db
      .select({
        id: walletConnections.id,
        kind: walletConnections.kind,
        status: walletConnections.status,
        createdAt: walletConnections.createdAt,
      })
      .from(walletConnections)
      .where(
        and(
          eq(walletConnections.userId, request.userId!),
          eq(walletConnections.status, 'connected'),
        ),
      )
      .orderBy(desc(walletConnections.createdAt))
      .limit(1);
    return { wallet: row ?? null };
  });
}
