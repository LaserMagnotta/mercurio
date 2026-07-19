import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { authMethodEnum } from './enums.js';
import { users } from './users.js';

// Magic-link tokens (ADR-009). Only the hash is stored - the raw token is
// emailed and never persisted - so a DB read alone cannot authenticate.
// Single-use: `consumedAt` is set atomically on verification.
export const magicLinkTokens = pgTable('magic_link_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  email: text('email').notNull(), // looked up before we know if the user exists yet (first login = signup)
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Server-side sessions. Only the hash of the session token is stored (same
// rationale as magic links: a DB leak alone can't impersonate a session).
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  method: authMethodEnum('method').notNull().default('magic_link'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});
