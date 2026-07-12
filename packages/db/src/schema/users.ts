import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// The base account. Every user can act as a sender (implicit — creating a
// shipment requires no separate profile); carrier and hub are opt-in roles
// with their own profile tables (carrierProfiles, hubs) — ARCHITECTURE.md §4,
// "un account può attivare uno o più ruoli".
//
// `deletedAt` marks a GDPR-anonymized account (RISKS.md §6): on deletion we
// scrub PII from this row but keep the id, because the ledger and custody
// chain are append-only and reference it forever.
export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull().unique(),
  locale: text('locale').notNull().default('it'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

// One row per accepted policy version (GDPR: proof of consent, RISKS.md §6).
// Kept even after account anonymization — it is evidence *the platform*
// needs, not personal data about the user's activity.
export const consentEvents = pgTable('consent_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  type: text('type').notNull(), // consentTypeEnum values; kept as text to allow new policy types without a migration
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
});

// Carrier role activation (ARCHITECTURE.md §4 roles). Rating is never cached
// here: it is always computed on read from `reviews` (no balance/aggregate
// computed ahead of time and left to drift — same principle as the ledger).
export const carrierProfiles = pgTable('carrier_profiles', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id),
  activatedAt: timestamp('activated_at', { withTimezone: true }).notNull().defaultNow(),
});
