// Timer sweep (ADR-011): shipment_timers rows are FACTS written in the same
// transaction as the transition that opened the deadline; this sweep turns
// the due ones into timeout events. The machine re-verifies state and
// deadline itself — a stale timer (the pickup happened, the leg was funded)
// is rejected by the transition and simply deleted: "i job sono promemoria,
// la verità è nella macchina a stati".

import { asc, eq, lte } from 'drizzle-orm';
import { shipmentTimers } from '@mercurio/db';
import type { ShipmentEvent } from '@mercurio/shared';
import { executeShipmentTransition, type LifecycleDeps } from './executor';
import { ConflictError, TransitionRejectedError } from './errors';

type TimerRow = typeof shipmentTimers.$inferSelect;

function timerEvent(timer: TimerRow, nowIso: string): ShipmentEvent {
  switch (timer.kind) {
    case 'leg_funding':
      return { type: 'leg_funding_expired', now: nowIso };
    case 'pickup':
      return { type: 'pickup_timeout', now: nowIso };
    case 'transit':
      return { type: 'transit_timeout', now: nowIso };
    case 'storage':
      return { type: 'storage_expiry', now: nowIso };
  }
}

export interface TimerSweepResult {
  fired: number;
  stale: number;
}

export async function fireDueTimers(deps: LifecycleDeps, limit = 50): Promise<TimerSweepResult> {
  const now = deps.now();
  const due = await deps.db
    .select()
    .from(shipmentTimers)
    .where(lte(shipmentTimers.fireAt, now))
    .orderBy(asc(shipmentTimers.fireAt))
    .limit(limit);

  let fired = 0;
  let stale = 0;
  for (const timer of due) {
    try {
      await executeShipmentTransition(deps, {
        shipmentId: timer.shipmentId,
        event: timerEvent(timer, now.toISOString()),
        consumeTimerId: timer.id,
      });
      fired += 1;
    } catch (err) {
      if (err instanceof TransitionRejectedError || err instanceof ConflictError) {
        // The deadline no longer applies (the transition it guarded already
        // happened, or the shipment moved on): consume the reminder.
        await deps.db.delete(shipmentTimers).where(eq(shipmentTimers.id, timer.id));
        stale += 1;
      } else {
        // Wallet trouble etc.: keep the row, the next sweep retries.
        console.warn(
          `timer ${timer.kind}:${timer.refId} failed (will retry):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  return { fired, stale };
}
