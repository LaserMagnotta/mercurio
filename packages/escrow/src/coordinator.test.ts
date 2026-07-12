// Unit tests of the non-custodial coordinator against the fake in-memory
// Lightning network (ADR-004: money logic is unit-tested on the fake and
// integration-tested on regtest — never on mocks that can't say no).

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  conditionalPayments,
  findOrCreateAccount,
  getAccountBalance,
  journalEntries,
} from '@mercurio/db';
import { FakeLightningNetwork, type FakeWalletConnection } from './adapters/fake';
import { PreimageCoordinator } from './coordinator';
import { EscrowError, type WalletConnection } from './types';
import { createEscrowWorld, type EscrowWorld } from './testing/world';

const AMOUNT = 5_000_000n; // 5000 sat
const HOLD_WINDOW_S = 3600;

describe('PreimageCoordinator (fake Lightning, pglite ledger)', () => {
  let world: EscrowWorld;
  let network: FakeLightningNetwork;
  let nowMs: number;
  let wallets: Map<string, FakeWalletConnection>;
  let resolvedUserIds: Set<string>;
  let coordinator: PreimageCoordinator;

  beforeEach(async () => {
    world = await createEscrowWorld();
    nowMs = Date.UTC(2026, 6, 12, 12, 0, 0);
    network = new FakeLightningNetwork(() => nowMs);
    wallets = new Map([
      [world.senderId, network.wallet(world.senderId, 100_000_000n)],
      [world.carrierId, network.wallet(world.carrierId, 100_000_000n)],
    ]);
    resolvedUserIds = new Set();
    coordinator = new PreimageCoordinator({
      db: world.db,
      resolveWallet: async (userId): Promise<WalletConnection> => {
        resolvedUserIds.add(userId);
        const wallet = wallets.get(userId);
        if (!wallet) throw new Error(`no wallet for ${userId}`);
        return wallet;
      },
      coordinatorKey: randomBytes(32),
      now: () => nowMs,
    });
  });

  function createParams(idem = 'idem-1') {
    return {
      shipmentId: world.shipmentId,
      payerId: world.senderId, // the sender pays the leg hold...
      payeeId: world.carrierId, // ...issued by the carrier (ESCROW.md §3 row 1)
      amountMsat: AMOUNT,
      purpose: 'leg_payment' as const,
      ref: { type: 'leg' as const, id: crypto.randomUUID() },
      holdWindowSeconds: HOLD_WINDOW_S,
      idem,
    };
  }

  async function ledgerBalances() {
    const payerAccount = await findOrCreateAccount(world.db, {
      ownerType: 'user',
      ownerId: world.senderId,
      kind: 'external_wallet',
    });
    const payeeAccount = await findOrCreateAccount(world.db, {
      ownerType: 'user',
      ownerId: world.carrierId,
      kind: 'external_wallet',
    });
    const commitmentAccount = await findOrCreateAccount(world.db, {
      ownerType: 'shipment',
      ownerId: world.shipmentId,
      kind: 'commitment',
    });
    return {
      payer: await getAccountBalance(world.db, payerAccount),
      payee: await getAccountBalance(world.db, payeeAccount),
      commitment: await getAccountBalance(world.db, commitmentAccount),
    };
  }

  async function paymentRow(id: string) {
    const [row] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    if (!row) throw new Error('payment row missing');
    return row;
  }

  it('create: preimage stored only encrypted, invoice issued by payee, paid by payer', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    const row = await paymentRow(id);

    expect(row.state).toBe('created');
    expect(row.bolt11).toBeTruthy();
    expect(row.preimageEncrypted).toMatch(/^gcm1:/); // never plaintext at rest
    expect(row.paymentHash).toMatch(/^[0-9a-f]{64}$/);
    // The payer's funds are already in flight toward the payee (hold paid).
    expect(network.balanceOf(world.senderId)).toBe(100_000_000n - AMOUNT);
    expect(network.balanceOf(world.carrierId)).toBe(100_000_000n); // nothing collected yet
    expect(await network.invoiceState(row.paymentHash)).toBe('held');
  });

  it('pollOnce observes the hold: state held + balanced shadow-ledger entry', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    const events = await coordinator.pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'payment_held', paymentId: id, amountMsat: AMOUNT });
    expect((await paymentRow(id)).state).toBe('held');
    expect(await ledgerBalances()).toEqual({
      payer: -AMOUNT,
      payee: 0n,
      commitment: AMOUNT,
    });

    // A second sweep finds nothing new to report.
    expect(await coordinator.pollOnce()).toHaveLength(0);
  });

  it('create is idempotent on idem; a reused key with other params is refused', async () => {
    const id1 = await coordinator.createConditionalPayment(createParams('same-key'));
    const id2 = await coordinator.createConditionalPayment(createParams('same-key'));
    expect(id2).toBe(id1);
    // Paid exactly once despite the retry.
    expect(network.balanceOf(world.senderId)).toBe(100_000_000n - AMOUNT);

    await expect(
      coordinator.createConditionalPayment({
        ...createParams('same-key'),
        amountMsat: AMOUNT * 2n,
      }),
    ).rejects.toThrow(EscrowError);
  });

  it('release: the payee actually collects, entries settle the commitment', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce();

    await coordinator.release(id, 'release-1');

    const row = await paymentRow(id);
    expect(row.state).toBe('settled');
    expect(row.resolvedAt).not.toBeNull();
    // Real collection on the (fake) network: payer -> payee, directly.
    expect(network.balanceOf(world.carrierId)).toBe(100_000_000n + AMOUNT);
    expect(network.balanceOf(world.senderId)).toBe(100_000_000n - AMOUNT);
    expect(await ledgerBalances()).toEqual({ payer: -AMOUNT, payee: AMOUNT, commitment: 0n });

    // Idempotent: releasing again changes nothing (no double journal entry).
    await coordinator.release(id, 'release-2');
    expect(await ledgerBalances()).toEqual({ payer: -AMOUNT, payee: AMOUNT, commitment: 0n });
  });

  it('release refuses a payment that is not held (funds not committed yet)', async () => {
    // Payer cannot afford the hold: the invoice stays open.
    wallets.set(world.senderId, network.wallet('broke-' + world.senderId, 0n));
    const id = await coordinator.createConditionalPayment(createParams());
    expect((await paymentRow(id)).state).toBe('created');

    await expect(coordinator.release(id, 'r')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('refund after held: funds return to the payer, ledger nets to zero', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce();

    await coordinator.refund(id, 'refund-1');

    expect((await paymentRow(id)).state).toBe('cancelled');
    expect(network.balanceOf(world.senderId)).toBe(100_000_000n); // made whole
    expect(network.balanceOf(world.carrierId)).toBe(100_000_000n);
    expect(await ledgerBalances()).toEqual({ payer: 0n, payee: 0n, commitment: 0n });

    await coordinator.refund(id, 'refund-2'); // idempotent
    expect(await ledgerBalances()).toEqual({ payer: 0n, payee: 0n, commitment: 0n });
  });

  it('refund before held: no commitment ever existed, so no journal entries', async () => {
    wallets.set(world.senderId, network.wallet('broke2-' + world.senderId, 0n));
    const id = await coordinator.createConditionalPayment(createParams());

    await coordinator.refund(id, 'refund-early');

    expect((await paymentRow(id)).state).toBe('cancelled');
    const entries = await world.db.select().from(journalEntries);
    expect(entries).toHaveLength(0); // ARCHITECTURE.md §5, implementation decision 1
  });

  it('refund refuses a settled payment', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce();
    await coordinator.release(id, 'r');
    await expect(coordinator.refund(id, 'x')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('an unpaid hold expires past the window; no ledger entries', async () => {
    wallets.set(world.senderId, network.wallet('broke3-' + world.senderId, 0n));
    const id = await coordinator.createConditionalPayment(createParams());

    nowMs += (HOLD_WINDOW_S + 10) * 1000; // past window + grace
    const events = await coordinator.pollOnce();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'payment_expired', paymentId: id });
    expect((await paymentRow(id)).state).toBe('expired');
    expect(await world.db.select().from(journalEntries)).toHaveLength(0);
  });

  it('a hold cancelled by the payee is refunded and recorded as cancelled', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce(); // held
    const row = await paymentRow(id);

    // The payee cancels unilaterally (their wallet, their right).
    await wallets.get(world.carrierId)!.cancelHoldInvoice(row.paymentHash);
    const events = await coordinator.pollOnce();

    expect(events[0]).toMatchObject({ type: 'payment_cancelled', paymentId: id });
    expect(network.balanceOf(world.senderId)).toBe(100_000_000n);
    expect(await ledgerBalances()).toEqual({ payer: 0n, payee: 0n, commitment: 0n });
  });

  it('zero custody: only the payer and payee wallets are ever contacted, and no account but theirs (plus the shipment commitment) is touched', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce();
    await coordinator.release(id, 'r');

    // Structural invariant 1 (ARCHITECTURE.md §5): the platform is never a
    // party. The coordinator asked for exactly two wallets...
    expect(resolvedUserIds).toEqual(new Set([world.senderId, world.carrierId]));
    // ...and every ledger account belongs to one of them or to the shipment.
    const { accounts } = await import('@mercurio/db');
    const rows = await world.db.select().from(accounts);
    for (const account of rows) {
      expect([world.senderId, world.carrierId, world.shipmentId]).toContain(account.ownerId);
    }
  });

  it('the fake network refuses to settle without the true preimage', async () => {
    const id = await coordinator.createConditionalPayment(createParams());
    await coordinator.pollOnce();
    // Not even the payee can collect without the coordinator's reveal.
    await expect(
      wallets.get(world.carrierId)!.settleHoldInvoice(randomBytes(32).toString('hex')),
    ).rejects.toThrow(/unknown invoice/);
    await coordinator.release(id, 'r'); // with the true preimage it works
    expect((await paymentRow(id)).state).toBe('settled');
  });

  it('events() streams observed transitions until aborted', async () => {
    const controller = new AbortController();
    const received: string[] = [];
    const consumer = (async () => {
      for await (const event of coordinator.events({
        pollIntervalMs: 5,
        signal: controller.signal,
      })) {
        received.push(event.type);
        controller.abort();
      }
    })();

    await coordinator.createConditionalPayment(createParams());
    await consumer;
    expect(received).toEqual(['payment_held']);
  });
});
