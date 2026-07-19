// Database-backed WalletResolver (ESCROW.md §5): maps a user to THEIR wallet
// connection. Mercurio never holds funds; it only asks the user's own wallet
// to act (ADR-013). Adapters:
//   - lnd_rest  → the user's own LND node (dev/regtest, or any reachable LND)
//   - fake      → in-memory network for tests and local demos
//   - nwc       → Nostr Wallet Connect, any hold-invoice-capable wallet service
//                 (ADR-019 closes the ADR-013 roadmap item)
//
// The connection secret is stored encrypted (secret-box, COORDINATOR_KEY);
// decrypting it here lets the API ASK the wallet to issue/pay — it never
// confers custody of anything.

import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { walletConnections } from '@mercurio/db';
import {
  LndRestWallet,
  NwcWallet,
  parseNwcUri,
  type FakeLightningNetwork,
  type NwcEncryption,
  type WalletResolver,
} from '@mercurio/escrow';
import { openSecret } from './secret-box.js';

export interface WalletResolverOptions {
  key: Buffer;
  /** Present in dev/test builds only: backs `kind = 'fake'` connections. */
  fakeNetwork?: FakeLightningNetwork;
  /** Balance a fake wallet starts with the first time it is resolved (dev
   *  demos need spendable sats; existing wallets keep their balance). */
  fakeInitialBalanceMsat?: bigint;
}

export class WalletUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletUnavailableError';
  }
}

/** ADR-019 §4: an NWC wallet without the hold-invoice extension can connect
 *  (capabilities.holdInvoice = false) but no money-bearing role may use it —
 *  every role ends up issuing a hold invoice as payee at some point
 *  (ESCROW.md §3: bonds are issued by the party they protect). Distinct from
 *  WalletUnavailableError (no/unreachable wallet) so the API can tell a user
 *  "reconnect a capable wallet" apart from "connect a wallet at all". */
export class WalletCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletCapabilityError';
  }
}

interface LndRestSecret {
  baseUrl: string;
  macaroonHex: string;
  allowInsecure?: boolean;
}

interface NwcCapabilitiesColumn {
  holdInvoice?: boolean;
  encryption?: NwcEncryption;
}

/** Whether the resolver (and hasConnectedWallet below) would accept this
 *  connection for a money-bearing role — kept in one place so both agree. */
function isUsableForMoney(kind: string, capabilities: unknown): boolean {
  if (kind !== 'nwc') return true;
  return (capabilities as NwcCapabilitiesColumn | null)?.holdInvoice === true;
}

export function createDbWalletResolver(db: Db, opts: WalletResolverOptions): WalletResolver {
  return async (userId) => {
    const [row] = await db
      .select()
      .from(walletConnections)
      .where(and(eq(walletConnections.userId, userId), eq(walletConnections.status, 'connected')))
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
        return opts.fakeNetwork.wallet(secret, opts.fakeInitialBalanceMsat ?? 0n);
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
      case 'nwc': {
        if (!isUsableForMoney(row.kind, row.capabilities)) {
          throw new WalletCapabilityError(
            `user ${userId}'s NWC wallet has no hold-invoice support (ADR-019)`,
          );
        }
        const capabilities = row.capabilities as NwcCapabilitiesColumn;
        return new NwcWallet(parseNwcUri(secret), {
          encryption: capabilities.encryption ?? 'nip44_v2',
        });
      }
    }
  };
}

/** True when the user has a wallet connection the resolver would accept for
 *  a money-bearing role (ADR-019 §4: an NWC wallet without hold-invoice
 *  support does NOT count, even though it has a 'connected' row). */
export async function hasConnectedWallet(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ kind: walletConnections.kind, capabilities: walletConnections.capabilities })
    .from(walletConnections)
    .where(and(eq(walletConnections.userId, userId), eq(walletConnections.status, 'connected')))
    .limit(1);
  if (!row) return false;
  return isUsableForMoney(row.kind, row.capabilities);
}
