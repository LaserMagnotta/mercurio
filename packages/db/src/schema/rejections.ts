import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { rejectionStageEnum } from './enums';
import { shipments } from './shipments';
import { legs } from './legs';
import { hubStays } from './hub-stays';
import { users } from './users';

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
