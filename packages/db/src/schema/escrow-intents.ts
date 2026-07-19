import { integer, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { escrowIntentVerbEnum } from './enums.js';
import { conditionalPayments } from './conditional-payments.js';

// Pending release/refund verbs queued by the effect executor (ADR-013).
//
// The paired shadow-ledger entries are written INSIDE the transition's
// transaction (keys cp:<paymentId>:<transizione>); the coordinator verb that
// actually reveals/cancels the preimage is wallet I/O and runs right after
// commit. If the process dies in between, this row survives and a worker
// retries the verb until it sticks — release() and refund() are idempotent,
// so at-least-once execution converges. The nightly reconciliation
// (invariant 6) remains the safety net for anything else.
export const escrowIntents = pgTable(
  'escrow_intents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => conditionalPayments.id),
    verb: escrowIntentVerbEnum('verb').notNull(),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('escrow_intents_payment_verb_idx').on(table.paymentId, table.verb)],
);
