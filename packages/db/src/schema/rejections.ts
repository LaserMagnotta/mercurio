import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { rejectionStageEnum } from './enums.js';
import { shipments } from './shipments.js';
import { legs } from './legs.js';
import { hubStays } from './hub-stays.js';
import { users } from './users.js';

// A rejected handoff (ADR-012, RISKS.md sec.1): documentation, not a
// dispute. Custody never passes and no money moves - it only notifies the
// sender, who can react with `reroute`/`boost`.
export const rejections = pgTable('rejections', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  legId: uuid('leg_id').references(() => legs.id),
  hubStayId: uuid('hub_stay_id').references(() => hubStays.id),
  rejectedBy: uuid('rejected_by')
    .notNull()
    .references(() => users.id),
  stage: rejectionStageEnum('stage').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
