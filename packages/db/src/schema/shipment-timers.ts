import { pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { shipmentTimerKindEnum } from './enums';
import { shipments } from './shipments';

// Timer FACTS for the shipment state machine (ADR-011). A `schedule_timeout`
// effect inserts a row here in the SAME transaction as its transition ("o
// entrambi o nessuno"); `cancel_timeout` deletes it; a pg-boss job sweeps the
// due rows and feeds the corresponding timeout event back into the machine,
// which re-verifies state and deadline itself — the row is a reminder, the
// machine is the truth. Keeping the facts in a table (instead of scheduling
// one pg-boss job per deadline) preserves the transactional-atomicity
// argument of ADR-011 while staying deterministic under test (fireDueTimers
// takes an injected `now`).
export const shipmentTimers = pgTable(
  'shipment_timers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    kind: shipmentTimerKindEnum('kind').notNull(),
    // The leg (leg_funding, pickup, transit) or hub stay (storage) the
    // deadline belongs to. No FK: same one-direction rationale as
    // conditional_payments.ref_id.
    refId: uuid('ref_id').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('shipment_timers_kind_ref_idx').on(table.kind, table.refId)],
);
