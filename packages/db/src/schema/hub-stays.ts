import { integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { hubStayStatusEnum } from './enums.js';
import { hubs } from './hubs.js';
import { shipments } from './shipments.js';
import { conditionalPayments } from './conditional-payments.js';

// One stay of a shipment at a hub (ARCHITECTURE.md sec.4). The hub's
// earnings are tracked on the adjacent legs (`arrHubFeeMsat` of the incoming
// leg, `depHubFeeMsat` of the outgoing one) - this table only tracks
// custody and the bond hold, never a fee amount (there is no prefunded pot
// to pay from).
export const hubStays = pgTable('hub_stays', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  hubId: uuid('hub_id')
    .notNull()
    .references(() => hubs.id),
  seq: integer('seq').notNull(),
  status: hubStayStatusEnum('status').notNull().default('reserved'),
  reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  checkedOutAt: timestamp('checked_out_at', { withTimezone: true }),
  storageDeadlineAt: timestamp('storage_deadline_at', { withTimezone: true }),
  bondConditionalPaymentId: uuid('bond_cp_id').references(() => conditionalPayments.id),
  // End of the CURRENT bond hold's renewal window (ADR-033): every hold
  // covers <= 7 days of storage, the coordinator chains the next one before
  // this instant. NULL on legacy stays (created under the 7-day cap): they
  // never renew, so a missing window simply means "no renewal scheduled".
  bondWindowEndsAt: timestamp('bond_window_ends_at', { withTimezone: true }),
});
