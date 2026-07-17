import { defineConfig } from 'vitest/config';

// The api suites are END-TO-END: each file boots a full world (pglite with
// every migration, fake Lightning network, buildApp). Under parallel load
// the first test of a file routinely exceeds vitest's 5s default without
// anything being wrong — the budget below is per test, not a slowdown.
export default defineConfig({
  test: {
    testTimeout: 30_000,
  },
});
