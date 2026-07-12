import { defineConfig } from 'vitest/config';

// Integration suite against the regtest Lightning environment (ADR-004):
//   docker compose -f infra/docker/docker-compose.yml up -d
//   ./infra/docker/bootstrap.sh
//   pnpm test:integration
// Real hold invoices, real preimage reveals, real refunds — money logic is
// never validated on mocks alone (CLAUDE.md).
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The three LND nodes share channels: run files (and tests) serially so
    // balance assertions never race each other.
    fileParallelism: false,
  },
});
