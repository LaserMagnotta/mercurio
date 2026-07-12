import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { photoKindEnum } from './enums';
import { shipments } from './shipments';
import { custodyEvents } from './custody-events';
import { rejections } from './rejections';
import { users } from './users';

// Photo evidence (RISKS.md sec.1). `purgeAfter` enforces limited retention
// (GDPR minimization, RISKS.md sec.6) - a worker job deletes the blob and
// this row once passed.
export const photos = pgTable('photos', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  custodyEventId: uuid('custody_event_id').references(() => custodyEvents.id),
  rejectionId: uuid('rejection_id').references(() => rejections.id),
  kind: photoKindEnum('kind').notNull(),
  storageKey: text('storage_key').notNull(),
  sha256: text('sha256').notNull(),
  takenBy: uuid('taken_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
});
