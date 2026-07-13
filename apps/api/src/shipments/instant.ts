// On-the-spot instant payments (ESCROW.md §3): hub fees at physical handoffs
// and the sender's cancellation compensation. Wallet-to-wallet, never held,
// never near the platform (ADR-013) — the payee's wallet issues a normal
// invoice, the payer's wallet pays it, and the transition that the payment
// gates proceeds only once the payee's wallet reports it settled
// ("la certificazione si sblocca a pagamento avvenuto").
//
// Retry safety: the row is keyed by a DETERMINISTIC idempotency key
// (fee:<refType>:<refId>:<reason> — one departure fee per leg, one arrival
// fee per leg, one compensation per shipment), created before any wallet
// I/O and advanced step by step: a retried transition finds the settled row
// and pays nothing twice.

import { eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { instantPayments } from '@mercurio/db';
import type { WalletResolver } from '@mercurio/escrow';
import type { ShipmentEffect } from '@mercurio/shared';
import { PaymentExecutionError } from './errors';

type InstantEffect = Extract<ShipmentEffect, { kind: 'request_instant_payment' }>;
type InstantRow = typeof instantPayments.$inferSelect;

export interface InstantPaymentDeps {
  db: Db;
  resolveWallet: WalletResolver;
  now: () => Date;
  /** Settlement polling knobs (tests: 1 attempt is enough on the fake). */
  waitAttempts?: number;
  waitDelayMs?: number;
}

export function instantPaymentIdem(effect: InstantEffect): string {
  return `fee:${effect.ref.type}:${effect.ref.id}:${effect.reason}`;
}

const DEFAULT_WAIT_ATTEMPTS = 10;
const DEFAULT_WAIT_DELAY_MS = 200;

/** Same generous cap the coordinator uses (ESCROW.md §4): short routes. */
const maxRoutingFeeMsat = (amountMsat: bigint): bigint => amountMsat / 100n + 1000n;

export async function settleInstantPayment(
  deps: InstantPaymentDeps,
  shipmentId: string,
  effect: InstantEffect,
): Promise<void> {
  const idem = instantPaymentIdem(effect);
  let row = await findOrCreateRow(deps.db, shipmentId, effect, idem);
  if (
    row.amountMsat !== effect.amountMsat ||
    row.payerId !== effect.payerId ||
    row.payeeId !== effect.payeeId
  ) {
    throw new PaymentExecutionError(
      'instant_idem_conflict',
      `instant payment ${idem} exists with different parameters`,
    );
  }
  if (row.state === 'settled') return;

  const payeeWallet = await deps.resolveWallet(effect.payeeId);

  // Resumable step 1: the payee's wallet issues the invoice.
  if (!row.bolt11 || !row.paymentHash) {
    const memo = `mercurio ${effect.reason} ${effect.ref.type}:${effect.ref.id}`;
    const { bolt11, paymentHash } = await payeeWallet.makeInvoice(effect.amountMsat, memo);
    await deps.db
      .update(instantPayments)
      .set({ bolt11, paymentHash })
      .where(eq(instantPayments.id, row.id));
    row = { ...row, bolt11, paymentHash };
  }

  // Resumable step 2: the payer's wallet pays. On a retry the invoice may
  // already be paid/settled — the wallet will refuse a double payment; the
  // settlement check below is the truth either way.
  const payerWallet = await deps.resolveWallet(effect.payerId);
  try {
    await payerWallet.payInvoice(row.bolt11!, maxRoutingFeeMsat(effect.amountMsat));
  } catch (err) {
    // Fall through to the lookup: "already settled" is a success in disguise,
    // anything else surfaces as a failed settlement check.
    console.warn(
      `instant payment ${idem}: dispatch failed (checking settlement):`,
      err instanceof Error ? err.message : err,
    );
  }

  // Step 3: certification unlocks only on observed settlement.
  const attempts = deps.waitAttempts ?? DEFAULT_WAIT_ATTEMPTS;
  const delayMs = deps.waitDelayMs ?? DEFAULT_WAIT_DELAY_MS;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await payeeWallet.lookupInvoice(row.paymentHash!);
    if (state === 'settled') {
      await deps.db
        .update(instantPayments)
        .set({ state: 'settled', settledAt: deps.now() })
        .where(eq(instantPayments.id, row.id));
      return;
    }
    if (attempt < attempts - 1) await sleep(delayMs);
  }
  throw new PaymentExecutionError(
    'instant_payment_failed',
    `instant payment ${idem} did not settle (${effect.amountMsat} msat ${effect.payerId} -> ${effect.payeeId})`,
  );
}

async function findOrCreateRow(
  db: Db,
  shipmentId: string,
  effect: InstantEffect,
  idem: string,
): Promise<InstantRow> {
  const inserted = await db
    .insert(instantPayments)
    .values({
      shipmentId,
      payerId: effect.payerId,
      payeeId: effect.payeeId,
      amountMsat: effect.amountMsat,
      reason: effect.reason,
      refType: effect.ref.type,
      refId: effect.ref.id,
      idempotencyKey: idem,
    })
    .onConflictDoNothing({ target: instantPayments.idempotencyKey })
    .returning();
  if (inserted[0]) return inserted[0];
  const [existing] = await db
    .select()
    .from(instantPayments)
    .where(eq(instantPayments.idempotencyKey, idem));
  if (!existing) throw new Error(`instant payment ${idem}: insert race lost and row not found`);
  return existing;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
