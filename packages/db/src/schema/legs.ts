import { sql } from 'drizzle-orm';
import { bigint, doublePrecision, integer, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { legStatusEnum } from './enums';
import { hubs } from './hubs';
import { shipments } from './shipments';
import { carrierTrips } from './carrier-trips';
import { users } from './users';
import { conditionalPayments } from './conditional-payments';

// One leg of a multi-hop shipment (ARCHITECTURE.md sec.4, ECONOMICS.md sec.3).
// Amounts are computed and frozen at `leg_accept`; the two hub fees are
// percentages of `grossMsat`, paid on the spot at the physical handoffs -
// they are never held here, only the leg payment and the carrier bond are
// (via `paymentConditionalPaymentId` / `bondConditionalPaymentId`).
// `finalizationBonusMsat` is the carrier share of the ADR-014 bonus, frozen
// only on the leg that delivers to the destination hub (0 elsewhere); the
// leg-payment hold amount is grossMsat + finalizationBonusMsat.
export const legs = pgTable('legs', {
  id: uuid('id').defaultRandom().primaryKey(),
  shipmentId: uuid('shipment_id')
    .notNull()
    .references(() => shipments.id),
  seq: integer('seq').notNull(),
  carrierId: uuid('carrier_id')
    .notNull()
    .references(() => users.id),
  tripId: uuid('trip_id')
    .notNull()
    .references(() => carrierTrips.id),
  fromHubId: uuid('from_hub_id')
    .notNull()
    .references(() => hubs.id),
  toHubId: uuid('to_hub_id')
    .notNull()
    .references(() => hubs.id),

  status: legStatusEnum('status').notNull().default('pending_funding'),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  fundingDeadlineAt: timestamp('funding_deadline_at', { withTimezone: true }).notNull(),
  pickupDeadlineAt: timestamp('pickup_deadline_at', { withTimezone: true }),
  transitDeadlineAt: timestamp('transit_deadline_at', { withTimezone: true }),

  progressKm: doublePrecision('progress_km').notNull(),
  grossMsat: bigint('gross_msat', { mode: 'bigint' }).notNull(),
  depHubFeeMsat: bigint('dep_hub_fee_msat', { mode: 'bigint' }).notNull(),
  arrHubFeeMsat: bigint('arr_hub_fee_msat', { mode: 'bigint' }).notNull(),
  netMsat: bigint('net_msat', { mode: 'bigint' }).notNull(),
  // sql`0` rather than 0n: drizzle-kit cannot serialize bigint literals into
  // its snapshot (JSON.stringify), the SQL default is identical.
  finalizationBonusMsat: bigint('finalization_bonus_msat', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),

  paymentConditionalPaymentId: uuid('payment_cp_id').references(() => conditionalPayments.id),
  bondConditionalPaymentId: uuid('bond_cp_id').references(() => conditionalPayments.id),
});
