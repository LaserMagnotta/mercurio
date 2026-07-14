import { defineConfig } from 'vitest/config';

// Unit tests cover the client-side logic that must never drift: amount
// formatting (ADR-008), state→copy completeness in BOTH locales, and the
// API client's error normalization. Pure node environment — no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts'],
  },
});
