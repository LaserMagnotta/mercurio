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
    expect(() =>
      assertProductionSafeEnv({ NODE_ENV: 'production', EUR_RATE_PROVIDER: 'market' }),
    ).not.toThrow();
    expect(() =>
      assertProductionSafeEnv({
        NODE_ENV: 'production',
        EUR_RATE_PROVIDER: 'market',
        FAKE_WALLETS: 'false',
      }),
    ).not.toThrow();
  });

  // ADR-025 §7: in production no EUR rate may come from a default — neither
  // the provider itself nor the fixed provider's placeholder number.
  it('refuses to default the EUR rate provider in production', () => {
    expect(() => assertProductionSafeEnv({ NODE_ENV: 'production' })).toThrow(ProductionGuardError);
  });

  it('refuses the fixed provider in production without an explicit rate', () => {
    expect(() =>
      assertProductionSafeEnv({ NODE_ENV: 'production', EUR_RATE_PROVIDER: 'fixed' }),
    ).toThrow(ProductionGuardError);
  });

  it('allows a rate pinned by hand: the way out when every feed breaks at once', () => {
    expect(() =>
      assertProductionSafeEnv({
        NODE_ENV: 'production',
        EUR_RATE_PROVIDER: 'fixed',
        EUR_RATE_SATS_PER_EUR: '1821',
      }),
    ).not.toThrow();
  });

  it('leaves the EUR rate defaults alone outside production', () => {
    expect(() => assertProductionSafeEnv({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionSafeEnv({})).not.toThrow();
  });
});
