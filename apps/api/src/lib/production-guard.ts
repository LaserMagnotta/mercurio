// Startup guard for the dev-only switches (ADR-024, ADR-025).
//
// FAKE_WALLETS backs wallet connections with an in-memory Lightning network
// (ADR-018 §Conseguenze): holds settle because a fake says so, no bond is
// ever really posted, and the parties' real wallets are never touched. Under
// NODE_ENV=production that is not a degraded mode, it is a lie about money —
// users would certify custody against payments that do not exist. There is no
// legitimate reason for the two to be set together, so refuse to boot rather
// than serve one request in that state.
//
// The EUR rate is the same shape of problem one step removed (ADR-025 §7): the
// defaults are the dev ones, and in production a wrong rate sizes the 1000 €
// ToS bond cap and freezes into every shipment for its whole life while
// nothing looks broken. Hence the rule: IN PRODUCTION NO RATE MAY COME FROM A
// DEFAULT. Both defaults — which provider, and the fixed provider's
// placeholder number — must be spelled out by whoever deploys.

export class ProductionGuardError extends Error {}

export function assertProductionSafeEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.FAKE_WALLETS === 'true') {
    throw new ProductionGuardError(
      'FAKE_WALLETS=true with NODE_ENV=production: the fake Lightning network ' +
        'must never back real users (ADR-013 zero custody, ADR-024). Unset one of the two.',
    );
  }

  if (env.EUR_RATE_PROVIDER === undefined) {
    throw new ProductionGuardError(
      'EUR_RATE_PROVIDER is unset with NODE_ENV=production: it would default to the fixed ' +
        'development rate, which nobody ever updates (ADR-025). Set EUR_RATE_PROVIDER=market ' +
        'to track real BTC/EUR tickers, or =fixed with an explicit EUR_RATE_SATS_PER_EUR if ' +
        'you really mean to pin the rate by hand.',
    );
  }

  if (env.EUR_RATE_PROVIDER === 'fixed' && env.EUR_RATE_SATS_PER_EUR === undefined) {
    throw new ProductionGuardError(
      'EUR_RATE_PROVIDER=fixed with NODE_ENV=production and no EUR_RATE_SATS_PER_EUR: the ' +
        "default 1600 sats/€ is the canonical example's scale, not a price (ADR-008). It would " +
        'size the 1000 € ToS bond cap and freeze into every shipment created. Set the rate ' +
        'explicitly, or use EUR_RATE_PROVIDER=market (ADR-025).',
    );
  }
}
