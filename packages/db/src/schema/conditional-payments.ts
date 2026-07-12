import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  conditionalPaymentPurposeEnum,
  conditionalPaymentRefTypeEnum,
  conditionalPaymentStateEnum,
} from './enums';
import { users } from './users';

// The only "hold" primitive in Mercurio (ADR-013, ESCROW.md sec.2): a hold
// invoice directly between payer and payee, hash generated here. Revealing
// `preimageEncrypted` to the payee = release; discarding it = cancel/refund.
// `refType`/`refId` point at a leg or hub_stay WITHOUT a foreign key (a leg
// can reference a conditional_payment and vice versa) - resolved in
// application code, never both directions as FKs to avoid a cycle.
export const conditionalPayments = pgTable('conditional_payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  payerId: uuid('payer_id')
    .notNull()
    .references(() => users.id),
  payeeId: uuid('payee_id')
    .notNull()
    .references(() => users.id),
  amountMsat: bigint('amount_msat', { mode: 'bigint' }).notNull(),
  purpose: conditionalPaymentPurposeEnum('purpose').notNull(),
  refType: conditionalPaymentRefTypeEnum('ref_type').notNull(),
  refId: uuid('ref_id').notNull(),
  paymentHash: text('payment_hash').notNull().unique(),
  preimageEncrypted: text('preimage_encrypted'), // set at creation, revealed (decrypted) only on release
  bolt11: text('bolt11'),
  state: conditionalPaymentStateEnum('state').notNull().default('created'),
  holdWindowSeconds: integer('hold_window_seconds').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
