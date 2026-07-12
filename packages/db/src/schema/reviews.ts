import { integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { reviewRoleEnum } from './enums';
import { shipments } from './shipments';
import { users } from './users';

// Per-role 5-star reviews (CLAUDE.md: "si puo' essere un ottimo vettore e
// un pessimo hub"). Ratings are never cached: always computed on read as an
// aggregate over this table (same principle as the ledger - no stale
// balances/aggregates computed ahead of time).
export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    shipmentId: uuid('shipment_id')
      .notNull()
      .references(() => shipments.id),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id),
    subjectId: uuid('subject_id')
      .notNull()
      .references(() => users.id),
    role: reviewRoleEnum('role').notNull(),
    stars: integer('stars').notNull(), // 1..5, checked in migration
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('reviews_shipment_author_subject_role_key').on(
      table.shipmentId,
      table.authorId,
      table.subjectId,
      table.role,
    ),
  ],
);
