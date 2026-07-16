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
import {
  NODES,
  localBalanceMsat,
  macaroonHex,
  preflightNode,
  waitFor,
  type NodeName,
} from './testing/regtest';
import { createEscrowWorld, type EscrowWorld } from './testing/world';

const AMOUNT = 100_000n; // msat = 100 sat

describe('coordinator against LND regtest (hold invoices for real)', () => {
  let wallets: Record<NodeName, LndRestWallet>;
  let world: EscrowWorld;
  let coordinator: PreimageCoordinator;
  let userToNode: Map<string, NodeName>;

  beforeAll(async () => {
    wallets = {
      alice: new LndRestWallet({
        baseUrl: NODES.alice,
        macaroonHex: macaroonHex('alice'),
        allowInsecure: true,
      }),
      bob: new LndRestWallet({
        baseUrl: NODES.bob,
        macaroonHex: macaroonHex('bob'),
        allowInsecure: true,
      }),
      carol: new LndRestWallet({
        baseUrl: NODES.carol,
        macaroonHex: macaroonHex('carol'),
        allowInsecure: true,
      }),
    };
    // Preflight: nodes reachable, synced, channels active — otherwise fail
    // with instructions instead of forty timeouts.
    for (const node of Object.keys(NODES) as NodeName[]) {
      await preflightNode(node);
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

  function createParams(
    overrides: Partial<Parameters<PreimageCoordinator['createConditionalPayment']>[0]> = {},
  ) {
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
