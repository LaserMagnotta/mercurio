// Workaround config (see memory note): drizzle-kit's CJS loader cannot parse
// the `.js` ESM import specifiers in src/schema/*.ts on this branch, so
// migrations are generated against the COMPILED schema. Run
// `pnpm --filter @mercurio/db build` first, then
// `pnpm exec drizzle-kit generate --config drizzle.config.compiled.ts`.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './dist/schema/index.js',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://mercurio:mercurio@localhost:5432/mercurio',
  },
});
