import { bigint, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accountKindEnum, accountOwnerTypeEnum } from './enums.js';

// Double-entry SHADOW ledger (ADR-010, ADR-013): it records commitments and
// settlements observed on users' own wallets. There is deliberately no
// account kind representing a platform-owned balance - that absence is the
// zero-custody invariant (ARCHITECTURE.md sec.5 invariant #1), and is
// checked by a test that enumerates `accountKindEnum` and asserts none of
// them can hold platform funds.
export const accounts = pgTable('accounts', {
  id: uuid('id').defaultRandom().primaryKey(),
  ownerType: accountOwnerTypeEnum('owner_type').notNull(),
  ownerId: uuid('owner_id').notNull(),
  kind: accountKindEnum('kind').notNull(),
  currency: text('currency').notNull().default('msat'),
});

// One entry per domain event that moves (or commits) money. `idempotencyKey`
// is unique so wallet-events and retries can never double-post.
export const journalEntries = pgTable('journal_entries', {
  id: uuid('id').defaultRandom().primaryKey(),
  eventType: text('event_type').notNull(),
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Postings for a journal entry MUST sum to zero - enforced by a deferred
// constraint trigger at the database level (see migrations), not only in
// application code (CLAUDE.md: "nessuna logica di denaro senza test").
export const postings = pgTable(
  'postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntries.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    amountMsat: bigint('amount_msat', { mode: 'bigint' }).notNull(), // signed
  },
  (table) => [index('postings_journal_entry_id_idx').on(table.journalEntryId)],
);
