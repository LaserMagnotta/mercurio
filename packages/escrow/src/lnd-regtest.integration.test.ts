// Integration suite: the coordinator against REAL hold invoices on the
// regtest Lightning environment (ADR-004). Prerequisites:
//
//   docker compose -f infra/docker/docker-compose.yml up -d
//   ./infra/docker/bootstrap.sh
//   pnpm test:integration
//
// alice = sender, bob = carrier, carol = hub (channels alice<->bob<->carol).
// The database side stays on pglite — what is under integration test here is
// the Lightning layer: HTLCs actually held, preimages actually revealed,
// funds actually moving between the users' own nodes.

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  conditionalPayments,
  findOrCreateAccount,
  getAccountBalance,
  journalEntries,
} from '@mercurio/db';
import { LndRestWallet } from './adapters/lnd-rest';
import { PreimageCoordinator } from './coordinator';
import type { CoordinatorEvent } from './types';
import { createEscrowWorld, type EscrowWorld } from './testing/world';

const AMOUNT = 100_000n; // msat = 100 sat
const NODES = {
  alice: process.env.LND_ALICE_REST ?? 'https://127.0.0.1:8081',
  bob: process.env.LND_BOB_REST ?? 'https://127.0.0.1:8082',
  carol: process.env.LND_CAROL_REST ?? 'https://127.0.0.1:8083',
} as const;
type NodeName = keyof typeof NODES;

const VOLUMES = fileURLToPath(new URL('../../../infra/docker/volumes/', import.meta.url));

function macaroonHex(node: NodeName): string {
  const path = `${VOLUMES}lnd-${node}/data/chain/bitcoin/regtest/admin.macaroon`;
  return readFileSync(path).toString('hex');
}

/** Raw REST call for assertions the WalletConnection interface does not
 *  (and should not) expose: getinfo, channel list, channel balance. */
function lndGet(node: NodeName, path: string): Promise<Record<string, unknown>> {
  const url = new URL(NODES[node]);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method: 'GET',
        host: url.hostname,
        port: Number(url.port),
        path,
        headers: { 'Grpc-Metadata-macaroon': macaroonHex(node) },
        rejectUnauthorized: false,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 300) resolve(JSON.parse(data));
          else reject(new Error(`${node} GET ${path}: ${res.statusCode} ${data.slice(0, 300)}`));
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function localBalanceMsat(node: NodeName): Promise<bigint> {
  const res = (await lndGet(node, '/v1/balance/channels')) as {
    local_balance?: { msat?: string };
  };
  return BigInt(res.local_balance?.msat ?? '0');
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 60_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await probe();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('coordinator against LND regtest (hold invoices for real)', () => {
  let wallets: Record<NodeName, LndRestWallet>;
  let world: EscrowWorld;
  let coordinator: PreimageCoordinator;
  let userToNode: Map<string, NodeName>;

  beforeAll(async () => {
    wallets = {
      alice: new LndRestWallet({ baseUrl: NODES.alice, macaroonHex: macaroonHex('alice'), allowInsecure: true }),
      bob: new LndRestWallet({ baseUrl: NODES.bob, macaroonHex: macaroonHex('bob'), allowInsecure: true }),
      carol: new LndRestWallet({ baseUrl: NODES.carol, macaroonHex: macaroonHex('carol'), allowInsecure: true }),
    };
    // Preflight: nodes reachable, synced, channels active — otherwise fail
    // with instructions instead of forty timeouts.
    for (const node of Object.keys(NODES) as NodeName[]) {
      const info = (await lndGet(node, '/v1/getinfo').catch((err) => {
        throw new Error(
          `lnd-${node} unreachable (${err}). Start the environment first:\n` +
            '  docker compose -f infra/docker/docker-compose.yml up -d\n' +
            '  ./infra/docker/bootstrap.sh',
        );
      })) as { synced_to_chain?: boolean };
      if (!info.synced_to_chain) throw new Error(`lnd-${node} not synced to chain`);
      const channels = (await lndGet(node, '/v1/channels?active_only=true')) as {
        channels?: unknown[];
      };
      if (!channels.channels?.length) {
        throw new Error(`lnd-${node} has no active channels — run infra/docker/bootstrap.sh`);
      }
    }
  });

  beforeEach(async () => {
    world = await createEscrowWorld(); // fresh pglite per test: ledger assertions stay local
    userToNode = new Map<string, NodeName>([
      [world.senderId, 'alice'],
      [world.carrierId, 'bob'],
      [world.hubOwnerId, 'carol'],
    ]);
    coordinator = new PreimageCoordinator({
      db: world.db,
      resolveWallet: async (userId) => {
        const node = userToNode.get(userId);
        if (!node) throw new Error(`no wallet mapping for user ${userId}`);
        return wallets[node];
      },
      coordinatorKey: randomBytes(32),
    });
  });

  function createParams(overrides: Partial<Parameters<PreimageCoordinator['createConditionalPayment']>[0]> = {}) {
    return {
      shipmentId: world.shipmentId,
      payerId: world.senderId, // alice
      payeeId: world.carrierId, // bob
      amountMsat: AMOUNT,
      purpose: 'leg_payment' as const,
      ref: { type: 'leg' as const, id: crypto.randomUUID() },
      holdWindowSeconds: 3600,
      idem: crypto.randomUUID(),
      ...overrides,
    };
  }

  async function waitForState(id: string, state: string): Promise<CoordinatorEvent[]> {
    const all: CoordinatorEvent[] = [];
    await waitFor(`payment ${id} -> ${state}`, async () => {
      all.push(...(await coordinator.pollOnce()));
      const [row] = await world.db
        .select()
        .from(conditionalPayments)
        .where(eq(conditionalPayments.id, id));
      return row?.state === state ? row : undefined;
    });
    return all;
  }

  async function commitmentBalance(): Promise<bigint> {
    const account = await findOrCreateAccount(world.db, {
      ownerType: 'shipment',
      ownerId: world.shipmentId,
      kind: 'commitment',
    });
    return getAccountBalance(world.db, account);
  }

  it('a paid hold becomes held: funds in flight, commitment on the ledger', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    const events = await waitForState(id, 'held');

    expect(events.some((e) => e.type === 'payment_held' && e.paymentId === id)).toBe(true);
    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(await wallets.bob.lookupInvoice(row!.paymentHash)).toBe('held');
    expect(await commitmentBalance()).toBe(AMOUNT);
  });

  it('release: the payee actually collects, straight from the payer', async () => {
    const bobBefore = await localBalanceMsat('bob');

    const id = await coordinator.createConditionalPayment(createParams());
    await waitForState(id, 'held');
    await coordinator.release(id, 'release-itest');

    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(row!.state).toBe('settled');
    await waitFor('bob invoice settled', async () =>
      (await wallets.bob.lookupInvoice(row!.paymentHash)) === 'settled' ? true : undefined,
    );
    // Real money on bob's side of the channel (direct hop: no routing fee).
    await waitFor('bob channel balance credited', async () => {
      const delta = (await localBalanceMsat('bob')) - bobBefore;
      return delta === AMOUNT ? true : undefined;
    });
    expect(await commitmentBalance()).toBe(0n); // held then settled: nets out
  });

  it('refund: the payer gets their funds back, untouched', async () => {
    const aliceBefore = await localBalanceMsat('alice');

    const id = await coordinator.createConditionalPayment(createParams());
    await waitForState(id, 'held');
    // The hold really bites: alice's spendable channel balance dropped.
    expect(await localBalanceMsat('alice')).toBeLessThan(aliceBefore);

    await coordinator.refund(id, 'refund-itest');

    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    expect(row!.state).toBe('cancelled');
    await waitFor('alice channel balance restored', async () =>
      (await localBalanceMsat('alice')) === aliceBefore ? true : undefined,
    );
    expect(await commitmentBalance()).toBe(0n);
  });

  it('an unpayable hold expires: no funds ever committed', async () => {
    // 20M sat >> the 5M sat channel: alice's payment dispatch fails, the
    // invoice can never be paid and dies by expiry.
    const id = await coordinator.createConditionalPayment(
      createParams({ amountMsat: 20_000_000_000n, holdWindowSeconds: 10 }),
    );
    const events = await waitForState(id, 'expired');

    expect(events.some((e) => e.type === 'payment_expired' && e.paymentId === id)).toBe(true);
    expect(await world.db.select().from(journalEntries)).toHaveLength(0);
  });
});
