import { bigint, doublePrecision, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { carrierTripStatusEnum } from './enums.js';
import { users } from './users.js';

// A carrier's declared real trip, consulted before browsing the board
// (MATCHING.md sec.1). Origin is implicit - where they are now / their
// reference hub - captured as lat/lng at declaration time.
export const carrierTrips = pgTable('carrier_trips', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  originLat: doublePrecision('origin_lat').notNull(),
  originLng: doublePrecision('origin_lng').notNull(),
  destLat: doublePrecision('dest_lat').notNull(),
  destLng: doublePrecision('dest_lng').notNull(),
  departsAt: timestamp('departs_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxDeviationKm: doublePrecision('max_deviation_km').notNull(),
  minRateMsatPerKm: bigint('min_rate_msat_per_km', { mode: 'bigint' }).notNull(),
  status: carrierTripStatusEnum('status').notNull().default('active'),
  // Declaration time, distinct from departsAt (which the carrier can set in
  // the future): GET /me/trips orders by this to find the most recently
  // declared trip, since ids are random (not time-ordered).
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
