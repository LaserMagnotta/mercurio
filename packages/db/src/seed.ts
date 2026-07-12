import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index';
import { seedDemoData } from './seed-data';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://mercurio:mercurio@localhost:5432/mercurio';

async function main() {
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema });
  await seedDemoData(db);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
