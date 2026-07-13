// EUR → sats exchange snapshot (ADR-008): EUR exists only at input/display;
// the rate is photographed at shipment creation and frozen for its whole
// life on `shipments.eur_rate_snapshot` (SATS per EUR, numeric 18,8).
//
// MVP provider: a fixed rate from the environment — regtest sats have no
// market price, and the protocol only needs SOME consistent snapshot. A real
// exchange-fed provider slots in behind the same interface later.

export interface EurRateSnapshot {
  /** Sats per 1 EUR, as a decimal string (column-lossless). */
  satsPerEur: string;
  source: string;
  at: Date;
}

export interface EurRateProvider {
  snapshot(): Promise<EurRateSnapshot>;
}

/** Default 1600 sats/€ — the canonical example's scale (5 € ≈ 8000 sats). */
const DEFAULT_SATS_PER_EUR = '1600';

export function createEnvEurRateProvider(
  env: Record<string, string | undefined> = process.env,
  now: () => Date = () => new Date(),
): EurRateProvider {
  const raw = env.EUR_RATE_SATS_PER_EUR ?? DEFAULT_SATS_PER_EUR;
  if (!/^\d{1,10}(\.\d{1,8})?$/.test(raw)) {
    throw new Error(`EUR_RATE_SATS_PER_EUR must be a positive decimal, got ${JSON.stringify(raw)}`);
  }
  return {
    snapshot: async () => ({ satsPerEur: raw, source: 'env-fixed', at: now() }),
  };
}

/**
 * Exact msat value of a whole-EUR amount at a snapshot (used for ToS caps
 * like the 1000 € bond ceiling — validation, not a money movement, but kept
 * in integer math anyway: floats never touch amounts).
 */
export function eurToMsat(wholeEur: number, satsPerEur: string): bigint {
  if (!Number.isInteger(wholeEur) || wholeEur < 0) {
    throw new RangeError(`wholeEur must be a non-negative integer, got ${wholeEur}`);
  }
  const [intPart, fracPart = ''] = satsPerEur.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(8, '0').slice(0, 8)); // sats × 10^8
  return (BigInt(wholeEur) * scaled * 1000n) / 100_000_000n;
}

/** msat per EUR as bigint (for the rate suggesters' observations). */
export function msatPerEur(satsPerEur: string): bigint {
  return eurToMsat(1, satsPerEur);
}
