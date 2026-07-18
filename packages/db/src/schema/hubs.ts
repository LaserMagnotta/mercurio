import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users.js';

// The hub profile (ARCHITECTURE.md sec.4). One per user, opt-in - the hub role.
export const hubs = pgTable('hubs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  name: text('name').notNull(),
  address: text('address').notNull(),
  // Optional contact address for the VENUE, distinct from the account email
  // (ADR-028): deposit-request notifications go here when set, otherwise to the
  // owner's account email. Never exposed publicly (GDPR minimization).
  contactEmail: text('contact_email'),
  lat: doublePrecision('lat').notNull(),
  lng: doublePrecision('lng').notNull(),
  openingHours: jsonb('opening_hours').notNull(),
  maxDimCmL: integer('max_dim_cm_l').notNull(),
  maxDimCmW: integer('max_dim_cm_w').notNull(),
  maxDimCmH: integer('max_dim_cm_h').notNull(),
  maxWeightG: integer('max_weight_g').notNull(),
  acceptsUndeclared: boolean('accepts_undeclared').notNull().default(false),
  // Percentage the hub retains from the gross of each adjacent leg (ECONOMICS.md sec.2), not from the shipment offer.
  feePercent: numeric('fee_percent', { precision: 5, scale: 2 }).notNull(),
  maxStorageDays: integer('max_storage_days').notNull(), // ADR-026: storage window in days

  // Pre-consent to deposit_accept (ADR-029): an auto_accept hub books deposits
  // instantly; a manual hub reviews each request from its dashboard. Default
  // FALSE (decisione B): a new hub is manual, opting into "always accept" on
  // purpose. Existing hubs keep their explicit value.
  autoAccept: boolean('auto_accept').notNull().default(false),
  active: boolean('active').notNull().default(true),
});
