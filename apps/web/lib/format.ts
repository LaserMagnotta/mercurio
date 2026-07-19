// Display-only formatting of protocol amounts (ADR-008). The API is the only
// source of every msat figure; this module never computes money — it renders
// it. The single sanctioned client-side arithmetic is the INDICATIVE euro
// countervalue, derived from the exchange snapshot the API attaches to the
// amount (frozen per shipment, or the current one for suggestions).

const MSAT_RE = /^\d{1,18}$/;
const RATE_RE = /^\d{1,10}(\.\d{1,8})?$/;

/** Whole sats contained in an API msat string (floor — sub-sat msat exist
 *  transiently in fee math server-side, never in anything we display). */
export function msatToSats(msat: string): bigint {
  if (!MSAT_RE.test(msat)) throw new RangeError(`not an msat string: ${JSON.stringify(msat)}`);
  return BigInt(msat) / 1000n;
}

/** Sats → msat string for request bodies. A UNIT conversion (×1000), not a
 *  money computation: the value is the user's own input. */
export function satsToMsat(sats: bigint): string {
  if (sats < 0n) throw new RangeError('sats must be non-negative');
  return (sats * 1000n).toString();
}

/** Locale-aware integer sats, e.g. 8000 → "8.000" (it). Unit label is the
 *  caller's job so copy stays in the i18n catalog. */
export function formatSats(msat: string, locale: string): string {
  return new Intl.NumberFormat(locale).format(msatToSats(msat));
}

/**
 * Indicative EUR countervalue of an msat amount at the given snapshot
 * (sats-per-EUR decimal string, as served by the API), or null when the rate
 * is missing/malformed — the UI then shows sats only, never a guess.
 * Integer bigint math up to whole cents; only the final cents fit a Number.
 */
export function formatEurIndicative(
  msat: string,
  satsPerEur: string | null | undefined,
  locale: string,
): string | null {
  if (!satsPerEur || !RATE_RE.test(satsPerEur)) return null;
  const [intPart, fracPart = ''] = satsPerEur.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(8, '0').slice(0, 8)); // sats × 10^8
  if (scaled === 0n) return null;
  const sats = msatToSats(msat);
  // cents = round(sats × 100 / satsPerEur)
  const numerator = sats * 100n * 100_000_000n;
  const cents = (numerator + scaled / 2n) / scaled;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
    Number(cents) / 100,
  );
}

/** Human form of a sats-per-EUR rate string: numeric(18,8) columns read
 *  back with trailing zeros ("1600.00000000") — trim them for display. */
export function formatSatsPerEur(satsPerEur: string): string {
  if (!satsPerEur.includes('.')) return satsPerEur;
  return satsPerEur.replace(/\.?0+$/, '');
}

/** Hub fee percentage: numeric(5,2) columns read back with trailing zeros
 *  ("10.00") — render locale-aware without them, e.g. "10" / "12,5" (it). */
export function formatPercent(percent: string, locale: string): string {
  const n = Number(percent);
  if (!Number.isFinite(n)) return percent;
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(n);
}

/** Kilometers with one decimal, e.g. 12.34 → "12,3 km" (it). */
export function formatKm(km: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(km)} km`;
}

/** Locale-aware date+time for timestamps coming from the API (ISO UTC). */
export function formatDateTime(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
