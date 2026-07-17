// Storage-expiry warnings (RISKS.md §4, ToS §10.1): sender and recipient get
// an email 72 h and 24 h before the storage deadline. The source of truth is
// the ARMED `storage` timer row — timers are deleted when a transition
// disarms them (executor `cancel_timeout`), so a warning can only go out
// while `storage_expiry` is actually still possible and can never contradict
// the state machine. Idempotency is per (stay, threshold, audience) checked
// against the outbox itself: a re-armed timer after `pickup_timeout` keeps
// the original deadline and the same stay id, so nothing is re-sent.

import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { emailOutbox, hubStays, shipments, shipmentTimers, users } from '@mercurio/db';
import { STORAGE_WARNING_HOURS } from '@mercurio/shared';

export interface StorageWarningDeps {
  db: Db;
  now: () => Date;
}

const HOUR_MS = 3_600_000;

interface WarningAudience {
  audience: 'sender' | 'recipient';
  to: string;
}

export interface StorageWarningResult {
  enqueued: number;
}

export async function enqueueStorageWarnings(
  deps: StorageWarningDeps,
): Promise<StorageWarningResult> {
  const now = deps.now();
  const horizon = new Date(now.getTime() + STORAGE_WARNING_HOURS[0] * HOUR_MS);

  const due = await deps.db
    .select({
      stayId: shipmentTimers.refId,
      fireAt: shipmentTimers.fireAt,
      shipmentId: shipmentTimers.shipmentId,
      recipientEmail: shipments.recipientEmail,
      senderEmail: users.email,
      senderDeletedAt: users.deletedAt,
      hubId: hubStays.hubId,
    })
    .from(shipmentTimers)
    .innerJoin(shipments, eq(shipments.id, shipmentTimers.shipmentId))
    .innerJoin(users, eq(users.id, shipments.senderId))
    .innerJoin(hubStays, eq(hubStays.id, shipmentTimers.refId))
    .where(
      and(
        eq(shipmentTimers.kind, 'storage'),
        gt(shipmentTimers.fireAt, now),
        lte(shipmentTimers.fireAt, horizon),
      ),
    );

  let enqueued = 0;
  for (const row of due) {
    // Most urgent threshold matched: a stay shorter than the lenient
    // threshold gets ONE catch-up warning, not the whole ladder at once.
    const remainingMs = row.fireAt.getTime() - now.getTime();
    const threshold = [...STORAGE_WARNING_HOURS].reverse().find((h) => remainingMs <= h * HOUR_MS);
    if (threshold === undefined) continue; // unreachable given the horizon filter

    const audiences: WarningAudience[] = [
      // An anonymized sender has no reachable mailbox (deleteAccount rewrites
      // the email to *.invalid) — same skip as the executor's queue_email.
      ...(row.senderDeletedAt === null
        ? [{ audience: 'sender', to: row.senderEmail } as const]
        : []),
      { audience: 'recipient', to: row.recipientEmail } as const,
    ];
    for (const { audience, to } of audiences) {
      const [already] = await deps.db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            eq(emailOutbox.template, 'storage_expiry_warning'),
            sql`${emailOutbox.payload}->>'stayId' = ${row.stayId}`,
            sql`${emailOutbox.payload}->>'threshold' = ${String(threshold)}`,
            sql`${emailOutbox.payload}->>'audience' = ${audience}`,
          ),
        )
        .limit(1);
      if (already) continue;
      await deps.db.insert(emailOutbox).values({
        to,
        template: 'storage_expiry_warning',
        payload: {
          shipmentId: row.shipmentId,
          stayId: row.stayId,
          hubId: row.hubId,
          deadline: row.fireAt.toISOString(),
          threshold: String(threshold),
          audience,
        },
      });
      enqueued += 1;
    }
  }
  return { enqueued };
}
