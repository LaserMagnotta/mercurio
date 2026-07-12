import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema/index';

// Single connection factory for the whole monorepo. DATABASE_URL matches
// the credentials in infra/docker/docker-compose.yml for local dev.
const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mercurio:mercurio@localhost:5432/mercurio';

export function createDb(url: string = connectionString) {
  const client = postgres(url);
  return drizzle(client, { schema });
}

// Driver-agnostic: accepts both the postgres-js instance used in dev/prod
// and the pglite instance used in tests (test-helpers.ts) - the ledger
// module only needs standard PgDatabase query-builder methods.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };
