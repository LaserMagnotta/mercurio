import { defineConfig } from 'vitest/config';

// Unit tests only: the regtest integration suite needs the Docker Lightning
// environment up and is run explicitly via `pnpm test:integration`
// (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
  },
});
