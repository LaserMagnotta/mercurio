import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { shipmentStatusEnum } from './enums.js';
import { hubs } from './hubs.js';
import { users } from './users.js';

// A shipment (ARCHITECTURE.md sec.4). `offerMsat` is a SPENDING COMMITMENT,
// not a prefunded pot: money moves leg by leg via direct P2P hold invoices
// (ADR-013). `custodyBondMsat` is the single bond amount required from
// whoever holds the parcel next, hub or carrier (ARCHITECTURE.md sec.6).
export const shipments = pgTable('shipments', {
  id: uuid('id').defaultRandom().primaryKey(),
  senderId: uuid('sender_id')
    .notNull()
    .references(() => users.id),
  originHubId: uuid('origin_hub_id')
    .notNull()
    .references(() => hubs.id),
  destHubId: uuid('dest_hub_id')
    .notNull()
    .references(() => hubs.id),
  recipientEmail: text('recipient_email').notNull(),
  recipientPickupOtpHash: text('recipient_pickup_otp_hash'),
  // Bearer credential for the recipient's early claim (ADR-016): minted at
  // origin_checkin, rotated by a recipient-changing reroute. Hash only, like
  // the OTP — the plaintext lives solely in the tracking email.
  recipientClaimTokenHash: text('recipient_claim_token_hash'),
  qrToken: text('qr_token').notNull().unique(),

  dimLCm: integer('dim_l_cm').notNull(),
  dimWCm: integer('dim_w_cm').notNull(),
  dimHCm: integer('dim_h_cm').notNull(),
  weightG: integer('weight_g').notNull(),
  declaredContent: text('declared_content'), // optional (CLAUDE.md: dichiararlo e' opzionale)
  undeclared: boolean('undeclared').notNull().default(false),

  offerMsat: bigint('offer_msat', { mode: 'bigint' }).notNull(),
  // The CURRENT price segment's work-pool commitment (ECONOMICS.md sec.5-6,
  // ADR-014): splitCommitment(offerMsat).workMsat at creation, then the
  // frozen remaining pool after each reroute ("il reroute apre un segmento").
  // Together with `distanceKm` (the segment's D) and the `boosted` custody
  // events since the last reroute, anyone can recompute the remaining pool.
  // sql`0` instead of 0n: drizzle-kit cannot serialize bigint literals.
  segmentWorkMsat: bigint('segment_work_msat', { mode: 'bigint' })
    .notNull()
    .default(sql`0`),
  custodyBondMsat: bigint('custody_bond_msat', { mode: 'bigint' }).notNull(),
  maxStorageHours: integer('max_storage_hours').notNull(), // <= 168h in MVP (ESCROW.md sec.4, CLTV budget)

  // Frozen at creation and used for the shipment's whole life (ADR-008): no
  // recalculation against a live rate mid-journey.
  eurRateSnapshot: numeric('eur_rate_snapshot', { precision: 18, scale: 8 }).notNull(),
  eurRateSource: text('eur_rate_source').notNull(),
  eurRateAt: timestamp('eur_rate_at', { withTimezone: true }).notNull(),

  status: shipmentStatusEnum('status').notNull().default('draft'),
  // Frozen origin->destination distance (D in ECONOMICS.md); recomputed on `reroute`.
  distanceKm: doublePrecision('distance_km').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
