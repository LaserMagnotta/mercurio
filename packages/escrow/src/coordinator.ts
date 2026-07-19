// The non-custodial escrow coordinator (ADR-013, ESCROW.md §2/§5).
//
// What it holds: preimages (information). What it never holds: money. Every
// conditional payment is a hold invoice issued by the payee's own wallet and
// paid by the payer's own wallet; the coordinator can only accelerate or
// deny an outcome between two counterparties fixed at issuance — revealing
// the preimage settles toward the payee, cancelling refunds the payer.
//
// State machine per payment: created -> held -> settled | cancelled | expired
// (created can also die to cancelled/expired if the hold is never paid).
// Transitions are driven by what the PAYEE's wallet reports (pollOnce), plus
// the two coordinator verbs release/refund. Every transition that changes
// committed funds writes a shadow double-entry journal entry (ADR-010) with
// a deterministic idempotency key `cp:<paymentId>:<held|settled|refunded>`,
// so retries, crashes and the API executing the state machine's paired
// ledger effects can never double-post.
//
// Ledger convention (mirrors packages/core state-machine posting builders):
//   held      payer external_wallet -a  /  shipment commitment +a
//   settled   shipment commitment  -a  /  payee external_wallet +a
//   refunded  shipment commitment  -a  /  payer external_wallet +a
// A payment that dies before ever being held posts nothing: a hold that was
// never accepted never became a commitment (ARCHITECTURE.md §5, decision 1).
//
// Ordering: the journal entry is posted BEFORE the row flips state. If we
// crash in between, the retry re-posts (no-op, idempotency key) and then
// flips — the ledger can run ahead of the row by one transition, never
// behind and never twice. Single writer assumed (the MVP worker); the
// nightly reconciliation job is the safety net either way (ADR-010).

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import {
  conditionalPayments,
  findOrCreateAccount,
  journalEntries,
  postJournalEntry,
} from '@mercurio/db';
import { decryptPreimage, encryptPreimage, generatePreimage } from './crypto.js';
import {
  EscrowError,
  type ConditionalPaymentId,
  type CoordinatorEvent,
  type CoordinatorEventType,
  type CreateConditionalPaymentParams,
  type EscrowCoordinator,
  type WalletResolver,
} from './types.js';

type PaymentRow = typeof conditionalPayments.$inferSelect;

export interface PreimageCoordinatorOptions {
  db: Db;
  resolveWallet: WalletResolver;
  /** 32-byte AES-256-GCM key — see loadCoordinatorKey(). */
  coordinatorKey: Buffer;
  /** Injectable clock (tests drive expiry deterministically). */
  now?: () => number;
  /** Routing-fee cap passed to the payer's wallet. Default: 1% + 1000 msat —
   *  generous for the short routes Mercurio expects (ESCROW.md §4). */
  maxRoutingFeeMsat?: (amountMsat: bigint) => bigint;
  /** Slack past the hold window before the coordinator itself declares an
   *  unpaid hold expired (wallets may garbage-collect lazily). */
  expiryGraceMs?: number;
}

const DEFAULT_EXPIRY_GRACE_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class PreimageCoordinator implements EscrowCoordinator {
  private readonly db: Db;
  private readonly resolveWallet: WalletResolver;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly maxRoutingFeeMsat: (amountMsat: bigint) => bigint;
  private readonly expiryGraceMs: number;
  private readonly listeners = new Set<(event: CoordinatorEvent) => void>();

  constructor(opts: PreimageCoordinatorOptions) {
    this.db = opts.db;
    this.resolveWallet = opts.resolveWallet;
    this.key = opts.coordinatorKey;
    this.now = opts.now ?? (() => Date.now());
    this.maxRoutingFeeMsat = opts.maxRoutingFeeMsat ?? ((amount) => amount / 100n + 1000n);
    this.expiryGraceMs = opts.expiryGraceMs ?? DEFAULT_EXPIRY_GRACE_MS;
  }

  // ---------------------------------------------------------------------
  // createConditionalPayment — ESCROW.md §2 step by step

  async createConditionalPayment(
    params: CreateConditionalPaymentParams,
  ): Promise<ConditionalPaymentId> {
    if (params.amountMsat <= 0n) {
      throw new EscrowError('invalid_state', 'amountMsat must be positive');
    }
    if (params.payerId === params.payeeId) {
      throw new EscrowError('invalid_state', 'payer and payee must differ');
    }

    let row = await this.findByIdem(params.idem);
    if (row) {
      // Same key must mean the same intent; a different payload under a
      // reused key is a caller bug we refuse to paper over.
      if (
        row.payerId !== params.payerId ||
        row.payeeId !== params.payeeId ||
        row.amountMsat !== params.amountMsat ||
        row.shipmentId !== params.shipmentId
      ) {
        throw new EscrowError('idem_conflict', `idem key ${params.idem} reused with other params`);
      }
    } else {
      // The preimage is born here and hits the database only encrypted.
      const { preimageHex, hashHex } = generatePreimage();
      const inserted = await this.db
        .insert(conditionalPayments)
        .values({
          shipmentId: params.shipmentId,
          payerId: params.payerId,
          payeeId: params.payeeId,
          amountMsat: params.amountMsat,
          purpose: params.purpose,
          refType: params.ref.type,
          refId: params.ref.id,
          paymentHash: hashHex,
          preimageEncrypted: encryptPreimage(preimageHex, this.key),
          state: 'created',
          holdWindowSeconds: params.holdWindowSeconds,
          idempotencyKey: params.idem,
          createdAt: new Date(this.now()),
        })
        .onConflictDoNothing({ target: conditionalPayments.idempotencyKey })
        .returning();
      row = inserted[0] ?? (await this.findByIdem(params.idem));
      if (!row) throw new EscrowError('payment_not_found', 'insert race lost and row not found');
    }

    // Resumable step 1: the PAYEE's wallet issues the hold invoice with our
    // hash. On a retried call that already did this, skip.
    if (!row.bolt11) {
      const payeeWallet = await this.resolveWallet(row.payeeId);
      const memo = `mercurio ${row.purpose} ${row.refType}:${row.refId}`;
      const { bolt11 } = await payeeWallet.makeHoldInvoice(
        row.amountMsat,
        row.paymentHash,
        row.holdWindowSeconds,
        memo,
      );
      await this.db
        .update(conditionalPayments)
        .set({ bolt11 })
        .where(eq(conditionalPayments.id, row.id));
      row = { ...row, bolt11 };
    }

    // Resumable step 2: the PAYER's wallet pays it. Dispatch failures (no
    // route, offline wallet) do NOT fail creation: the payment simply never
    // reaches `held` and the hold window expires it — the protocol's safe
    // default (ESCROW.md §2). pollOnce observes whatever actually happened.
    if (row.state === 'created' && row.bolt11) {
      const payerWallet = await this.resolveWallet(row.payerId);
      try {
        await payerWallet.payInvoice(row.bolt11, this.maxRoutingFeeMsat(row.amountMsat));
      } catch (err) {
        console.warn(
          `escrow: payment dispatch failed for ${row.id} (will expire if never paid):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return row.id;
  }

  // ---------------------------------------------------------------------
  // release / refund — the only two verbs the protocol has (ADR-012)

  async release(id: ConditionalPaymentId, _idem: string): Promise<void> {
    const row = await this.mustGet(id);
    if (row.state === 'settled') return; // idempotent
    if (row.state !== 'held') {
      throw new EscrowError('invalid_state', `cannot release payment in state ${row.state}`);
    }
    if (!row.preimageEncrypted) {
      throw new EscrowError('preimage_unavailable', `payment ${id} has no stored preimage`);
    }
    const preimageHex = decryptPreimage(row.preimageEncrypted, this.key);
    // Revealing the preimage to the payee's wallet IS the release: the payee
    // settles and collects directly from the payer. We are not in the flow.
    const payeeWallet = await this.resolveWallet(row.payeeId);
    await payeeWallet.settleHoldInvoice(preimageHex);
    await this.markSettled(row);
  }

  async refund(id: ConditionalPaymentId, _idem: string): Promise<void> {
    const row = await this.mustGet(id);
    if (row.state === 'cancelled' || row.state === 'expired') return; // idempotent
    if (row.state === 'settled') {
      throw new EscrowError('invalid_state', 'cannot refund a settled payment');
    }
    const payeeWallet = await this.resolveWallet(row.payeeId);
    await payeeWallet.cancelHoldInvoice(row.paymentHash);
    await this.markResolved(row, 'cancelled');
  }

  // ---------------------------------------------------------------------
  // Observation — wallet truth drives the states (ESCROW.md §5 events())

  async pollOnce(): Promise<CoordinatorEvent[]> {
    const open = await this.db
      .select()
      .from(conditionalPayments)
      .where(inArray(conditionalPayments.state, ['created', 'held']));

    const events: CoordinatorEvent[] = [];
    const record = (event: CoordinatorEvent | null) => {
      if (event) events.push(event);
    };

    for (const row of open) {
      try {
        record(await this.observe(row));
      } catch (err) {
        // One unreachable wallet must not stall every other payment.
        console.warn(
          `escrow: observation failed for payment ${row.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return events;
  }

  private async observe(row: PaymentRow): Promise<CoordinatorEvent | null> {
    const payeeWallet = await this.resolveWallet(row.payeeId);
    const walletState = await payeeWallet.lookupInvoice(row.paymentHash);
    const windowClosed =
      this.now() >= row.createdAt.getTime() + row.holdWindowSeconds * 1000 + this.expiryGraceMs;

    switch (walletState) {
      case 'held':
        return row.state === 'created' ? this.markHeld(row) : null;
      case 'settled':
        // The payee can only have settled with the preimage we revealed —
        // release() already flipped the row unless we crashed in between.
        return this.markSettled(row);
      case 'expired':
        return this.markResolved(row, 'expired');
      case 'cancelled':
        // We didn't cancel (refund() flips the row synchronously), so either
        // the payee cancelled unilaterally or the wallet expired the hold.
        return this.markResolved(row, windowClosed ? 'expired' : 'cancelled');
      case 'open':
        if (windowClosed) {
          // Wallet is lazy about expiry: close the door ourselves so a
          // late payment can't land, then record the expiry.
          await payeeWallet.cancelHoldInvoice(row.paymentHash).catch(() => undefined);
          return this.markResolved(row, 'expired');
        }
        return null;
    }
  }

  async *events(opts?: {
    pollIntervalMs?: number;
    signal?: AbortSignal;
  }): AsyncIterable<CoordinatorEvent> {
    const interval = opts?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const queue: CoordinatorEvent[] = [];
    const listener = (event: CoordinatorEvent) => queue.push(event);
    this.listeners.add(listener);
    try {
      while (!opts?.signal?.aborted) {
        await this.pollOnce(); // transitions funnel into `queue` via listener
        while (queue.length > 0) yield queue.shift()!;
        await sleep(interval, opts?.signal);
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  // ---------------------------------------------------------------------
  // Transitions — ledger entry first, then the row, then the event

  private async markHeld(row: PaymentRow): Promise<CoordinatorEvent | null> {
    await this.postHeldEntry(row);
    const flipped = await this.flipState(row.id, ['created'], 'held', null);
    return flipped ? this.emit('payment_held', row) : null;
  }

  private async markSettled(row: PaymentRow): Promise<CoordinatorEvent | null> {
    // If we never observed `held` (crash, missed poll) the commitment entry
    // is posted now — both entries are idempotent so the order is safe.
    await this.postHeldEntry(row);
    await this.postLedgerEntry(row, 'settled', 'conditional_payment_settled', [
      { owner: { type: 'shipment', id: row.shipmentId }, amountMsat: -row.amountMsat },
      { owner: { type: 'user', id: row.payeeId }, amountMsat: row.amountMsat },
    ]);
    const flipped = await this.flipState(row.id, ['created', 'held'], 'settled', this.nowDate());
    return flipped ? this.emit('payment_settled', row) : null;
  }

  /** Shared by cancel and expiry: both refund the payer (if anything was
   *  ever committed) and differ only in the recorded cause. */
  private async markResolved(
    row: PaymentRow,
    to: 'cancelled' | 'expired',
  ): Promise<CoordinatorEvent | null> {
    if (await this.wasHeld(row)) {
      await this.postLedgerEntry(row, 'refunded', `conditional_payment_${to}`, [
        { owner: { type: 'shipment', id: row.shipmentId }, amountMsat: -row.amountMsat },
        { owner: { type: 'user', id: row.payerId }, amountMsat: row.amountMsat },
      ]);
    }
    const flipped = await this.flipState(row.id, ['created', 'held'], to, this.nowDate());
    return flipped ? this.emit(to === 'expired' ? 'payment_expired' : 'payment_cancelled', row) : null;
  }

  private async postHeldEntry(row: PaymentRow): Promise<void> {
    await this.postLedgerEntry(row, 'held', 'conditional_payment_held', [
      { owner: { type: 'user', id: row.payerId }, amountMsat: -row.amountMsat },
      { owner: { type: 'shipment', id: row.shipmentId }, amountMsat: row.amountMsat },
    ]);
  }

  /** Committed funds ever existed iff the held entry exists (the row alone
   *  is not enough: we may have crashed between entry and flip). */
  private async wasHeld(row: PaymentRow): Promise<boolean> {
    if (row.state === 'held') return true;
    const [entry] = await this.db
      .select({ id: journalEntries.id })
      .from(journalEntries)
      .where(eq(journalEntries.idempotencyKey, `cp:${row.id}:held`));
    return entry !== undefined;
  }

  private async postLedgerEntry(
    row: PaymentRow,
    transition: 'held' | 'settled' | 'refunded',
    eventType: string,
    postings: { owner: { type: 'user' | 'shipment'; id: string }; amountMsat: bigint }[],
  ): Promise<void> {
    const resolved = await Promise.all(
      postings.map(async (p) => ({
        accountId: await findOrCreateAccount(this.db, {
          ownerType: p.owner.type,
          ownerId: p.owner.id,
          kind: p.owner.type === 'user' ? 'external_wallet' : 'commitment',
        }),
        amountMsat: p.amountMsat,
      })),
    );
    await postJournalEntry(this.db, {
      eventType,
      refType: row.refType,
      refId: row.refId,
      idempotencyKey: `cp:${row.id}:${transition}`,
      postings: resolved,
    });
  }

  /** Guarded state flip; false when another actor already moved the row. */
  private async flipState(
    id: string,
    from: ('created' | 'held')[],
    to: 'held' | 'settled' | 'cancelled' | 'expired',
    resolvedAt: Date | null,
  ): Promise<boolean> {
    const updated = await this.db
      .update(conditionalPayments)
      .set(resolvedAt ? { state: to, resolvedAt } : { state: to })
      .where(and(eq(conditionalPayments.id, id), inArray(conditionalPayments.state, from)))
      .returning({ id: conditionalPayments.id });
    return updated.length > 0;
  }

  private emit(type: CoordinatorEventType, row: PaymentRow): CoordinatorEvent {
    const event: CoordinatorEvent = {
      type,
      paymentId: row.id,
      shipmentId: row.shipmentId,
      purpose: row.purpose,
      ref: { type: row.refType, id: row.refId },
      amountMsat: row.amountMsat,
      payerId: row.payerId,
      payeeId: row.payeeId,
      at: new Date(this.now()).toISOString(),
    };
    for (const listener of this.listeners) listener(event);
    return event;
  }

  // ---------------------------------------------------------------------

  private nowDate(): Date {
    return new Date(this.now());
  }

  private async findByIdem(idem: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.idempotencyKey, idem));
    return row;
  }

  private async mustGet(id: string): Promise<PaymentRow> {
    const [row] = await this.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, id));
    if (!row) throw new EscrowError('payment_not_found', `conditional payment ${id} not found`);
    return row;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
