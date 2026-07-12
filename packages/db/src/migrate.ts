import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';

// Runs every SQL file in ./drizzle in order, including the hand-written
// ledger-invariant trigger (0001_..._ledger_balance_trigger.sql — ADR-010).
// Drizzle tracks applied migrations in its own table, so this is safe to
// re-run (idempotent), matching the "docker compose up + setup" contract.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mercurio:mercurio@localhost:5432/mercurio';

async function main() {
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client);
  console.log(`Running migrations against ${connectionString}...`);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)) });
  console.log('Migrations complete.');
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
