import { bigint, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { shipmentClaimStatusEnum } from './enums.js';
import { shipments } from './shipments.js';
import { users } from './users.js';
import { hubStays } from './hub-stays.js';
import { conditionalPayments } from './conditional-payments.js';

// One recipient claim (ADR-016): the history of who claimed what, where, for
// how much. Amounts are frozen at the request (ECONOMICS.md §5-ter) exactly
// like a leg freezes its pricing; the machine's guards allow at most one
// non-terminal claim per shipment, and the partial unique index in migration
// 0005 backs that at the database level. The claim's two holds reference this
// row (`conditional_payments.ref_type = 'claim'`), never the hub stay, so a
// claim can never collide with a hub-stay-referenced hold of a past final leg.
export const shipmentClaims = pgTable('shipment_claims', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  claimantId: uuid('claimant_id')
    .notNull()
    .references(() => users.id),
  // The stay the pickup happens at: custody never moves during a claim.
  hubStayId: uuid('hub_stay_id')
    .notNull()
    .references(() => hubStays.id),
  // floorToSat(remaining work pool) + floorToSat(unconsumed Π_v).
  claimPaymentMsat: bigint('claim_payment_msat', { mode: 'bigint' }).notNull(),
  // floorToSat(accrued Π_h); 0 means the hold was never created.
  hubBonusMsat: bigint('hub_bonus_msat', { mode: 'bigint' }).notNull(),
  paymentConditionalPaymentId: uuid('payment_cp_id').references(() => conditionalPayments.id),
  hubBonusConditionalPaymentId: uuid('hub_bonus_cp_id').references(() => conditionalPayments.id),
  status: shipmentClaimStatusEnum('status').notNull().default('pending_funding'),
  fundingDeadlineAt: timestamp('funding_deadline_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
