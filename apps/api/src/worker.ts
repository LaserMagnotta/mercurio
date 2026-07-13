// pg-boss workers (ADR-011). Scheduling and retries live in pg-boss; the
// actual work is plain functions (timers, pump, outbox, intents, reconcile)
// that are unit-tested directly on pglite — this file only wires cron to
// them. Workers run in the API process in the MVP and are separable later.
//
// Timer semantics: shipment_timers rows are written transactionally by the
// effect executor; the sweep here only FIRES the due ones. Losing a sweep
// tick delays a timeout, never loses it.

import PgBoss from 'pg-boss';
import type { SendMail } from './lib/mailer';
import type { LifecycleDeps } from './shipments/executor';
import { fireDueTimers } from './shipments/timers';
import { pumpWalletEvents } from './shipments/pump';
import { dispatchEmailOutbox } from './shipments/outbox';
import { reconcile, retryEscrowIntents } from './shipments/reconcile';

export interface WorkerOptions {
  lifecycle: LifecycleDeps;
  sendMail: SendMail;
  connectionString: string;
}

const QUEUES = {
  timers: 'mercurio-timers-sweep',
  pump: 'mercurio-wallet-pump',
  outbox: 'mercurio-outbox-dispatch',
  intents: 'mercurio-escrow-intents',
  reconcile: 'mercurio-reconcile',
} as const;

export async function startWorkers(opts: WorkerOptions): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: opts.connectionString });
  boss.on('error', (err) => console.error('pg-boss error:', err));
  await boss.start();

  for (const queue of Object.values(QUEUES)) {
    await boss.createQueue(queue);
  }

  // Minute-level cron is enough: the shortest deadline family (leg funding)
  // is 60 minutes, and wallet holds confirm within seconds of the sweep.
  await boss.schedule(QUEUES.timers, '* * * * *');
  await boss.schedule(QUEUES.pump, '* * * * *');
  await boss.schedule(QUEUES.outbox, '* * * * *');
  await boss.schedule(QUEUES.intents, '*/5 * * * *');
  await boss.schedule(QUEUES.reconcile, '0 3 * * *'); // nightly (invariant 6)

  await boss.work(QUEUES.timers, async () => {
    await fireDueTimers(opts.lifecycle);
  });
  await boss.work(QUEUES.pump, async () => {
    await pumpWalletEvents(opts.lifecycle);
  });
  await boss.work(QUEUES.outbox, async () => {
    await dispatchEmailOutbox({
      db: opts.lifecycle.db,
      sendMail: opts.sendMail,
      now: opts.lifecycle.now,
    });
  });
  await boss.work(QUEUES.intents, async () => {
    await retryEscrowIntents(opts.lifecycle);
  });
  await boss.work(QUEUES.reconcile, async () => {
    const report = await reconcile(opts.lifecycle);
    if (report.discrepancies.length === 0) {
      console.warn(
        `reconciliation clean: ${report.checkedPayments} payments, ${report.checkedShipments} shipments`,
      );
    }
  });

  return boss;
}
