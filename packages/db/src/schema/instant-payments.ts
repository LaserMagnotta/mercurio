import { bigint, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  conditionalPaymentRefTypeEnum,
  instantPaymentReasonEnum,
  instantPaymentStateEnum,
} from './enums';
import { shipments } from './shipments';
import { users } from './users';

// On-the-spot instant payments (ESCROW.md sec.3): hub fees at the physical
// handoffs and the sender's cancellation compensation. A normal invoice
// issued by the payee's wallet and paid by the payer's wallet — never held,
// never touched by the platform (ADR-013). This table exists so the effect
// executor can retry a transition without paying the same fee twice: the
// row is created (idempotency_key) before dispatching the payment, and the
// certification-unlocking transition proceeds only once `state = settled`.
export const instantPayments = pgTable('instant_payments', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  payerId: uuid('payer_id')
    .notNull()
    .references(() => users.id),
  payeeId: uuid('payee_id')
    .notNull()
    .references(() => users.id),
  amountMsat: bigint('amount_msat', { mode: 'bigint' }).notNull(),
  reason: instantPaymentReasonEnum('reason').notNull(),
  // 'leg' | 'hub_stay' for fees; the ledger ref 'shipment' (cancellation
  // compensation) is stored as text ref_type below — reuse of the cp enum
  // would forbid it, so this is plain text on purpose.
  refType: text('ref_type').notNull(),
  refId: uuid('ref_id').notNull(),
  bolt11: text('bolt11'),
  paymentHash: text('payment_hash'),
  state: instantPaymentStateEnum('state').notNull().default('created'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
});
