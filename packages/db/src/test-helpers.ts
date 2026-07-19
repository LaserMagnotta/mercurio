import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from './schema/index.js';

/**
 * An in-process Postgres (WASM, via pglite) with every migration applied.
 *
 * Used by the test suite so money-logic tests (ledger invariants, etc.) run
 * against a real Postgres engine - including the hand-written trigger in
 * 0001_ledger_invariants.sql - without requiring Docker. The dev/e2e
 * environment still uses real Postgres via infra/docker (ADR-004); this is
 * only a substitute for the unit/integration test database.
 */
export async function createTestDb() {
  const client = new PGlite();
  const migrationsDir = fileURLToPath(new URL('../drizzle', import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8');
    // drizzle-kit separates statements with a "--> statement-breakpoint" marker
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await client.exec(statement);
    }
  }

  return drizzle(client, { schema });
}
