import { defineConfig } from 'vitest/config';

// Integration suite against a real MinIO (ADR-023 §6):
//   docker compose -f infra/docker/docker-compose.yml up -d minio
//   pnpm --filter @mercurio/api test:integration
export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
