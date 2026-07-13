// Database-backed WalletResolver (ESCROW.md §5): maps a user to THEIR wallet
// connection. Mercurio never holds funds; it only asks the user's own wallet
// to act (ADR-013). Adapters:
//   - lnd_rest  → the user's own LND node (dev/regtest, or any reachable LND)
//   - fake      → in-memory network for tests and local demos
//   - nwc       → production roadmap, not implemented yet
//
// The connection secret is stored encrypted (secret-box, COORDINATOR_KEY);
// decrypting it here lets the API ASK the wallet to issue/pay — it never
// confers custody of anything.

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { walletConnections } from '@mercurio/db';
import { FakeLightningNetwork, LndRestWallet, type WalletResolver } from '@mercurio/escrow';
import { openSecret } from './secret-box';

export interface WalletResolverOptions {
  key: Buffer;
  /** Present in dev/test builds only: backs `kind = 'fake'` connections. */
  fakeNetwork?: FakeLightningNetwork;
}

export class WalletUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletUnavailableError';
  }
}

interface LndRestSecret {
  baseUrl: string;
  macaroonHex: string;
  allowInsecure?: boolean;
}

export function createDbWalletResolver(db: Db, opts: WalletResolverOptions): WalletResolver {
  return async (userId) => {
    const [row] = await db
      .select()
      .from(walletConnections)
      .where(
        and(eq(walletConnections.userId, userId), eq(walletConnections.status, 'connected')),
      )
      .orderBy(desc(walletConnections.createdAt))
      .limit(1);
    if (!row) {
      throw new WalletUnavailableError(`user ${userId} has no connected wallet`);
    }
    const secret = openSecret(row.connectionSecretEncrypted, opts.key);
    switch (row.kind) {
      case 'fake': {
        if (!opts.fakeNetwork) {
          throw new WalletUnavailableError('fake wallets are not enabled in this environment');
        }
        return opts.fakeNetwork.wallet(secret);
      }
      case 'lnd_rest': {
        const cfg = JSON.parse(secret) as LndRestSecret;
        if (!cfg.baseUrl || !cfg.macaroonHex) {
          throw new WalletUnavailableError('lnd_rest connection secret is malformed');
        }
        return new LndRestWallet({
          baseUrl: cfg.baseUrl,
          macaroonHex: cfg.macaroonHex,
          ...(cfg.allowInsecure !== undefined && { allowInsecure: cfg.allowInsecure }),
        });
      }
      case 'nwc':
        throw new WalletUnavailableError('NWC wallets are not implemented yet (ADR-013 roadmap)');
    }
  };
}

/** True when the user has a wallet connection the resolver would accept. */
export async function hasConnectedWallet(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: walletConnections.id })
    .from(walletConnections)
    .where(and(eq(walletConnections.userId, userId), eq(walletConnections.status, 'connected')))
    .limit(1);
  return row !== undefined;
}
