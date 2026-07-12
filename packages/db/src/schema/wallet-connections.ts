import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { walletKindEnum, walletStatusEnum } from './enums';
import { users } from './users';

// The user's own Lightning wallet connection (ESCROW.md sec.5, ADR-013).
// `connectionSecretEncrypted` holds the NWC connection string / node
// macaroon, encrypted at rest - it lets us ASK the user's wallet to act, it
// never gives the platform custody of funds.
export const walletConnections = pgTable('wallet_connections', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  kind: walletKindEnum('kind').notNull(),
  connectionSecretEncrypted: text('connection_secret_encrypted').notNull(),
  capabilities: jsonb('capabilities').notNull(), // e.g. { holdInvoice: true }
  status: walletStatusEnum('status').notNull().default('connected'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
