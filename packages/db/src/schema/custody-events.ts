import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { custodyEventTypeEnum } from './enums';
import { shipments } from './shipments';
import { users } from './users';
import { legs } from './legs';
import { hubStays } from './hub-stays';

// Append-only, hash-chained custody chain (ARCHITECTURE.md sec.4, RISKS.md
// sec.1): the documentary evidence of who certified what, used in place of
// an arbiter ruling (ADR-012). Never UPDATEd - corrections are new rows.
export const custodyEvents = pgTable('custody_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  type: custodyEventTypeEnum('type').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id), // null for worker-driven events (timeouts)
  legId: uuid('leg_id').references(() => legs.id),
  hubStayId: uuid('hub_stay_id').references(() => hubStays.id),
  payload: jsonb('payload').notNull().default({}),
  prevEventHash: text('prev_event_hash'), // null only for the shipment's first event
  hash: text('hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
