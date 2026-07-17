// Startup guard for the dev-only switches (ADR-024).
//
// FAKE_WALLETS backs wallet connections with an in-memory Lightning network
// (ADR-018 §Conseguenze): holds settle because a fake says so, no bond is
// ever really posted, and the parties' real wallets are never touched. Under
// NODE_ENV=production that is not a degraded mode, it is a lie about money —
// users would certify custody against payments that do not exist. There is no
// legitimate reason for the two to be set together, so refuse to boot rather
// than serve one request in that state.

export class ProductionGuardError extends Error {}

export function assertProductionSafeEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.FAKE_WALLETS === 'true') {
    throw new ProductionGuardError(
      'FAKE_WALLETS=true with NODE_ENV=production: the fake Lightning network ' +
        'must never back real users (ADR-013 zero custody, ADR-024). Unset one of the two.',
    );
  }
}
