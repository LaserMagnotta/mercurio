// Nightly reconciliation (ARCHITECTURE.md §5, invariant 6): the shadow
// ledger must agree with the observed reality of the users' wallets.
//
// Three passes:
//  1. observation — coordinator.pollOnce() aligns conditional-payment rows
//     (and their ledger entries) with what the payee wallets report;
//  2. per-payment audit — every row's journal entries match its state, under
//     the deterministic keys of ADR-013 §3;
//  3. per-shipment audit — each commitment account balance equals the sum of
//     currently-held unresolved payments (funds in flight toward the
//     shipment's outcomes), and no escrow intent is stuck.
//
// The report is returned AND logged; an MVP alert is a log line (the ops
// story grows later — the invariant is what matters).

import { eq, lt } from 'drizzle-orm';
import {
  conditionalPayments,
  escrowIntents,
  findOrCreateAccount,
  getAccountBalance,
  journalEntries,
} from '@mercurio/db';
import type { LifecycleDeps } from './executor.js';

export interface ReconciliationReport {
  checkedPayments: number;
  checkedShipments: number;
  discrepancies: string[];
}

const STUCK_INTENT_MS = 60 * 60 * 1000;

export async function reconcile(deps: LifecycleDeps): Promise<ReconciliationReport> {
  const discrepancies: string[] = [];

  // Pass 1 — wallet truth first: what follows audits a fresh picture.
  try {
    await deps.coordinator.pollOnce();
  } catch (err) {
    discrepancies.push(`pollOnce failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const payments = await deps.db.select().from(conditionalPayments);
  const keys = new Set(
    (
      await deps.db
        .select({ idem: journalEntries.idempotencyKey })
        .from(journalEntries)
    ).map((r) => r.idem),
  );

  // Pass 2 — entries per payment state.
  for (const cp of payments) {
    const held = keys.has(`cp:${cp.id}:held`);
    const settled = keys.has(`cp:${cp.id}:settled`);
    const refunded = keys.has(`cp:${cp.id}:refunded`);
    const complain = (msg: string) => discrepancies.push(`payment ${cp.id} (${cp.state}): ${msg}`);
    switch (cp.state) {
      case 'created':
        if (held || settled || refunded) complain('has ledger entries before being held');
        break;
      case 'held':
        if (!held) complain('missing held entry');
        if (settled || refunded) complain('resolved entries on an open hold');
        break;
      case 'settled':
        if (!held || !settled) complain('missing held/settled entry');
        if (refunded) complain('both settled and refunded');
        break;
      case 'cancelled':
      case 'expired':
        if (settled) complain('settled entry on a refunded hold');
        if (held !== refunded) complain('held/refunded entries do not pair up');
        break;
    }
  }

  // Pass 3 — commitment balances: Σ held-unresolved amounts per shipment
  // (a shipment with every hold resolved must balance to exactly zero).
  const byShipment = new Map<string, bigint>();
  for (const cp of payments) {
    const held = cp.state === 'held' ? cp.amountMsat : 0n;
    byShipment.set(cp.shipmentId, (byShipment.get(cp.shipmentId) ?? 0n) + held);
  }
  for (const [shipmentId, expected] of byShipment) {
    const accountId = await findOrCreateAccount(deps.db, {
      ownerType: 'shipment',
      ownerId: shipmentId,
      kind: 'commitment',
    });
    const balance = await getAccountBalance(deps.db, accountId);
    if (balance !== expected) {
      discrepancies.push(
        `shipment ${shipmentId}: commitment balance ${balance} != held in-flight ${expected}`,
      );
    }
  }

  // Stuck intents: a verb that failed for an hour deserves eyes.
  const stuckSince = new Date(deps.now().getTime() - STUCK_INTENT_MS);
  const stuck = await deps.db
    .select()
    .from(escrowIntents)
    .where(lt(escrowIntents.createdAt, stuckSince));
  for (const intent of stuck) {
    discrepancies.push(
      `escrow intent ${intent.verb} ${intent.paymentId} pending since ${intent.createdAt.toISOString()}`,
    );
  }

  const report: ReconciliationReport = {
    checkedPayments: payments.length,
    checkedShipments: byShipment.size,
    discrepancies,
  };
  if (discrepancies.length > 0) {
    console.error('RECONCILIATION DISCREPANCIES:', discrepancies);
  }
  return report;
}

/** Retry pending release/refund verbs (phase 3 leftovers). Both verbs are
 *  idempotent, so at-least-once execution converges (ADR-013). */
export async function retryEscrowIntents(
  deps: LifecycleDeps,
  opts: { olderThanMs?: number; limit?: number } = {},
): Promise<{ executed: number; failed: number }> {
  const cutoff = new Date(deps.now().getTime() - (opts.olderThanMs ?? 30_000));
  const rows = await deps.db
    .select()
    .from(escrowIntents)
    .where(lt(escrowIntents.createdAt, cutoff))
    .limit(opts.limit ?? 50);
  let executed = 0;
  let failed = 0;
  for (const intent of rows) {
    try {
      if (intent.verb === 'release') {
        await deps.coordinator.release(intent.paymentId, `cpv:${intent.paymentId}:release`);
      } else {
        await deps.coordinator.refund(intent.paymentId, `cpv:${intent.paymentId}:refund`);
      }
      await deps.db.delete(escrowIntents).where(eq(escrowIntents.id, intent.id));
      executed += 1;
    } catch (err) {
      failed += 1;
      await deps.db
        .update(escrowIntents)
        .set({ attempts: intent.attempts + 1 })
        .where(eq(escrowIntents.id, intent.id));
      console.warn(
        `escrow intent retry ${intent.verb} ${intent.paymentId} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return { executed, failed };
}
