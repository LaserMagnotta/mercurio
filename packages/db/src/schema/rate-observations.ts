import { bigint, doublePrecision, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { legs } from './legs';

// Feeds the suggested-rate calculation (MATCHING.md sec.4): only legs that
// were actually accepted and completed land here.
export const rateObservations = pgTable('rate_observations', {
  id: uuid('id').defaultRandom().primaryKey(),
  legId: uuid('leg_id')
    .notNull()
    .references(() => legs.id),
  detourKm: doublePrecision('detour_km').notNull(),
  netMsat: bigint('net_msat', { mode: 'bigint' }).notNull(),
  eurRate: numeric('eur_rate', { precision: 18, scale: 8 }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull(),
});
