import { describe, expect, it } from 'vitest';
import { assertProductionSafeEnv, ProductionGuardError } from './production-guard.js';

describe('assertProductionSafeEnv', () => {
  it('refuses fake wallets in production (ADR-013 zero custody, ADR-024)', () => {
    expect(() => assertProductionSafeEnv({ NODE_ENV: 'production', FAKE_WALLETS: 'true' })).toThrow(
      ProductionGuardError,
    );
  });

  it('leaves the dev combination alone', () => {
    expect(() =>
      assertProductionSafeEnv({ NODE_ENV: 'development', FAKE_WALLETS: 'true' }),
    ).not.toThrow();
    expect(() => assertProductionSafeEnv({ FAKE_WALLETS: 'true' })).not.toThrow();
  });

  it('leaves a real production boot alone', () => {
    expect(() => assertProductionSafeEnv({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertProductionSafeEnv({ NODE_ENV: 'production', FAKE_WALLETS: 'false' }),
    ).not.toThrow();
  });
});
