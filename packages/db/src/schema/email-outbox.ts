import { integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { emailStatusEnum } from './enums';

// Transactional email outbox (ARCHITECTURE.md sec.4): notifications are
// queued in the SAME transaction as the domain event and sent by a worker -
// so there is never a notification for an event that didn't happen, nor an
// event without one.
export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').defaultRandom().primaryKey(),
  to: text('to').notNull(),
  template: text('template').notNull(),
  payload: jsonb('payload').notNull(),
  status: emailStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
});
