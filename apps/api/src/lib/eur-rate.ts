// EUR → sats exchange snapshot (ADR-008): EUR exists only at input/display;
// the rate is photographed at shipment creation and frozen for its whole
// life on `shipments.eur_rate_snapshot` (SATS per EUR, numeric 18,8).
//
// Two providers behind one interface (ADR-025), picked by EUR_RATE_PROVIDER:
//
//   fixed (default) — a rate from the environment. The right answer for dev
//                     and regtest, whose sats have no market price (ADR-008),
//                     and a placeholder anywhere else.
//   market          — the median of several public keyless BTC/EUR tickers,
//                     cached in-process. Production.
//
// The integer math at the bottom is shared by both and predates them: the
// providers only decide WHICH `satsPerEur` string it operates on.

export interface EurRateSnapshot {
  /** Sats per 1 EUR, as a decimal string (column-lossless). */
  satsPerEur: string;
  source: string;
  /** When the rate was OBSERVED, not when it was asked for: a cached value
   *  keeps its original `at`, so a shipment records how old the price that
   *  governs it really was (ADR-025 §5). */
  at: Date;
}

/**
 * Why the caller wants a rate — the only thing that decides how stale a value
 * may be (ADR-025 §5). `freeze` writes it into a shipment for life and refuses
 * a value past the max age; `suggest` only prefills an input the user can
 * overwrite, so it takes whatever is cached. Defaults to the strict one: a
 * caller who has not thought about it gets the safe policy.
 */
export type EurRateUse = 'freeze' | 'suggest';

export interface EurRateProvider {
  snapshot(use?: EurRateUse): Promise<EurRateSnapshot>;
}

/** No rate usable for the caller's purpose: the feeds are unreachable, or the
 *  cached value is too old to freeze. Transient — routes map it to 503. */
export class EurRateUnavailableError extends Error {}

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

// --- Market provider (ADR-025) ----------------------------------------------

/** The slice of `fetch` this module uses. Injected by tests, which is how the
 *  suite exercises every failure mode without touching the network. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type HttpFetch = (url: string, init: { signal: AbortSignal }) => Promise<HttpResponse>;

/** A public ticker. `parse` pulls EUR-per-BTC out of the body as the feed
 *  quotes it — a decimal STRING, which is how all three publish it — or null
 *  when the body is not the shape we expect. */
export interface RateSource {
  name: string;
  url: string;
  parse(body: unknown): string | null;
}

/**
 * The keyless public tickers of ADR-025 §1. Three GETs with no parameters, no
 * body and no identifiers: no user data reaches an exchange, and the browser
 * never talks to one (that would leak the user's IP to a third party).
 *
 * The response shapes below were recorded from the live endpoints on
 * 2026-07-17 and are the fixtures the tests assert against. A shape that
 * drifts makes its source return null and drop out of the median — which is
 * what the quorum of §1 is for.
 */
/** An unknown JSON body as something indexable — `null`, arrays and primitives
 *  fall out. Keeps the parsers honest: a feed's body is unknown until proven
 *  otherwise, never a cast we simply assert. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

export const MARKET_SOURCES: Record<string, RateSource> = {
  // { "error": [], "result": { "XXBTZEUR": { "c": ["54929.00000", "0.0001"] } } }
  // `c` is the last closed trade, [price, volume]. Read the first (only) entry
  // of `result` rather than hardcoding Kraken's `XXBTZEUR` spelling of the
  // pair; an error response carries an empty `result` and falls out as null.
  kraken: {
    name: 'kraken',
    url: 'https://api.kraken.com/0/public/Ticker?pair=XBTEUR',
    parse(body) {
      const result = asRecord(asRecord(body)?.result);
      const pair = result === null ? null : asRecord(Object.values(result)[0]);
      const c = pair?.c;
      const last: unknown = Array.isArray(c) ? c[0] : undefined;
      return typeof last === 'string' ? last : null;
    },
  },
  // { "last": "54937.08", "bid": …, "ask": …, … } — every value a string.
  bitstamp: {
    name: 'bitstamp',
    url: 'https://www.bitstamp.net/api/v2/ticker/btceur/',
    parse(body) {
      const last = asRecord(body)?.last;
      return typeof last === 'string' ? last : null;
    },
  },
  // { "data": { "amount": "54912.25", "base": "BTC", "currency": "EUR" } }
  coinbase: {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/BTC-EUR/spot',
    parse(body) {
      const amount = asRecord(asRecord(body)?.data)?.amount;
      return typeof amount === 'string' ? amount : null;
    },
  },
};

/** A decimal string with at most 8 fractional digits: what the feeds quote and
 *  what `numeric(18,8)` stores. Anything else — `"N/A"`, `"1e5"`, a sign, an
 *  empty string — is a broken feed, not a price. */
const DECIMAL_RE = /^\d{1,12}(\.\d{1,8})?$/;

/** Feed-is-broken detectors, NOT a view on the market (ADR-025 §4): set far
 *  outside any plausible price so they catch zero, garbage and gross unit
 *  errors. Constants on purpose — widening one should be a reviewed change,
 *  not an env edited on the host at 3am while watching a chart. */
const MIN_EUR_PER_BTC = 1_000n;
const MAX_EUR_PER_BTC = 10_000_000n;

/** 10^8: the fixed-point scale of both sides, and sats per BTC. */
const SCALE = 100_000_000n;

/** S8 = satsPerEur × 10^8, or null when the quote is not a plausible price.
 *
 *  Integer math end to end (ADR-008: floats never touch money) — the quote
 *  goes from string to bigint without ever passing through `Number`:
 *
 *    satsPerEur = 10^8 / eurPerBtc, kept to 8 decimals
 *    S8 = 10^8 × 10^8 / eurPerBtc = 10^24 / (eurPerBtc × 10^8)
 *
 *  The division truncates at the 8th decimal of sats/€ (~10^-8 sats), and
 *  downwards: a hair conservative on the ToS cap, invisible everywhere else. */
function satsPerEurScaled8(eurPerBtc: string): bigint | null {
  if (!DECIMAL_RE.test(eurPerBtc)) return null;
  const [intPart, fracPart = ''] = eurPerBtc.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(8, '0').slice(0, 8)); // eurPerBtc × 10^8
  if (scaled < MIN_EUR_PER_BTC * SCALE || scaled > MAX_EUR_PER_BTC * SCALE) return null;
  return 10n ** 24n / scaled;
}

/** S8 back into the decimal string the rest of the module speaks. */
function formatScaled8(s8: bigint): string {
  return `${s8 / SCALE}.${(s8 % SCALE).toString().padStart(8, '0')}`;
}

/**
 * `satsPerEur` from a feed's EUR-per-BTC quote, or null when that quote is not
 * a plausible price (§4). Exported because it is the money-facing half of this
 * provider and deserves its own tests: 62 500 €/BTC must give exactly
 * 1600.00000000 sats/€, the historical placeholder.
 */
export function eurPerBtcToSatsPerEur(eurPerBtc: string): string | null {
  const s8 = satsPerEurScaled8(eurPerBtc);
  return s8 === null ? null : formatScaled8(s8);
}

/** Fresh enough to serve as-is. */
const DEFAULT_TTL_MS = 5 * 60_000;
/** Oldest a cached rate may be and still be FROZEN into a shipment (§5). */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60_000;
/** Fewer valid quotes than this and there is no corroboration — which is the
 *  entire reason for taking a median (§1). */
const DEFAULT_MIN_SOURCES = 2;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface MarketEurRateConfig {
  sources: RateSource[];
  /** Injected by tests; defaults to the global `fetch`. */
  fetch?: HttpFetch;
  now?: () => Date;
  ttlMs?: number;
  maxAgeMs?: number;
  minSources?: number;
  timeoutMs?: number;
}

interface Quote {
  name: string;
  s8: bigint;
}

/**
 * The median of several public tickers, cached in-process (ADR-025 §1, §6).
 *
 * On-demand with no cron: the rate is only ever needed to serve a request, so
 * a scheduled refresh would poll all night for nobody, and a cold cache after
 * a deploy would 503 until its first tick. One replica (ADR-024 §3) means one
 * cache and no coherence problem.
 */
export function createMarketEurRateProvider(config: MarketEurRateConfig): EurRateProvider {
  const doFetch: HttpFetch = config.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const now = config.now ?? (() => new Date());
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  const maxAgeMs = config.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const minSources = config.minSources ?? DEFAULT_MIN_SOURCES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (config.sources.length < minSources) {
    throw new Error(
      `eur rate: ${config.sources.length} source(s) configured but ${minSources} must agree; ` +
        'fewer sources than the quorum is the median switched off in silence (ADR-025 §1)',
    );
  }

  let cached: EurRateSnapshot | null = null;
  let inFlight: Promise<EurRateSnapshot | null> | null = null;

  /** One source's quote, or null for anything wrong with it: unreachable,
   *  timed out, non-2xx, not JSON, unexpected shape, implausible price. A bad
   *  source drops out of the median; it never fails the whole refresh. */
  async function quote(source: RateSource): Promise<Quote | null> {
    try {
      const res = await doFetch(source.url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const raw = source.parse(await res.json());
      const s8 = raw === null ? null : satsPerEurScaled8(raw);
      return s8 === null ? null : { name: source.name, s8 };
    } catch {
      return null;
    }
  }

  /** A new snapshot, or null when too few sources answered usefully. */
  async function refresh(): Promise<EurRateSnapshot | null> {
    const at = now();
    const settled = await Promise.all(config.sources.map(quote));
    const quotes = settled.filter((q): q is Quote => q !== null);
    if (quotes.length < minSources) return null;
    // Lower-middle median: the frozen rate is always a price some source really
    // quoted — auditable against that exchange's history — never an average
    // nobody ever published (ADR-025 §1).
    const sorted = [...quotes].sort((a, b) => (a.s8 < b.s8 ? -1 : a.s8 > b.s8 ? 1 : 0));
    const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
    cached = {
      satsPerEur: formatScaled8(median.s8),
      // Which sources actually backed this number (ADR-008: the source is
      // recorded in the snapshot), so a frozen rate stays auditable.
      source: `median(${quotes.map((q) => q.name).sort().join(',')})`,
      at,
    };
    return cached;
  }

  return {
    async snapshot(use = 'freeze') {
      if (cached && now().getTime() - cached.at.getTime() < ttlMs) return cached;
      // Single-flight: concurrent callers that find the cache stale share one
      // round of fetches instead of starting one each.
      inFlight ??= refresh().finally(() => {
        inFlight = null;
      });
      const fresh = await inFlight;
      if (fresh) return fresh;

      if (!cached) {
        throw new EurRateUnavailableError(
          'no EUR rate: the ticker feeds did not answer and nothing is cached yet',
        );
      }
      const ageMs = now().getTime() - cached.at.getTime();
      if (use === 'freeze' && ageMs > maxAgeMs) {
        throw new EurRateUnavailableError(
          `EUR rate is ${Math.round(ageMs / 60_000)} min old and the feeds are not answering: ` +
            'too stale to freeze into a shipment for its whole life (ADR-008)',
        );
      }
      return cached;
    },
  };
}

/**
 * Picks the provider from config (ADR-025 §7), same shape as
 * `createBlobStoreFromEnv`: `EUR_RATE_PROVIDER` defaults to `fixed`, so dev,
 * regtest and the test suite never reach the network by construction — and
 * regtest sats have no market price anyway (ADR-008). Production must ask for
 * `market` explicitly; `assertProductionSafeEnv` refuses to boot if it did not.
 */
export function createEurRateProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EurRateProvider {
  const provider = env.EUR_RATE_PROVIDER ?? 'fixed';
  if (provider === 'fixed') return createEnvEurRateProvider(env);
  if (provider === 'market') {
    const names = (env.EUR_RATE_SOURCES ?? Object.keys(MARKET_SOURCES).join(','))
      .split(',')
      .map((n) => n.trim())
      .filter((n) => n !== '');
    const sources = names.map((name) => {
      const source = MARKET_SOURCES[name];
      if (!source) {
        throw new Error(
          `eur rate: unknown source "${name}" in EUR_RATE_SOURCES ` +
            `(known: ${Object.keys(MARKET_SOURCES).join(', ')})`,
        );
      }
      return source;
    });
    return createMarketEurRateProvider({ sources });
  }
  throw new Error(`eur rate: unknown EUR_RATE_PROVIDER "${provider}" (expected fixed or market)`);
}

// --- Integer math (unchanged, shared by both providers) ----------------------

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

/**
 * Indicative msat value of a fractional-EUR amount, floored to a whole sat.
 * For SUGGESTIONS only (offer / min-rate anchors the UI prefixes into
 * sats-first inputs, ADR-008: EUR exists only at input/display): the EUR side
 * is quantized to cents before any arithmetic, so the only rounding is the
 * final floor-to-sat. Real money movements never pass through here — they are
 * priced in integer msat by the pure engines.
 */
export function eurFloatToMsat(eur: number, satsPerEur: string): bigint {
  if (!Number.isFinite(eur) || eur < 0) {
    throw new RangeError(`eur must be a non-negative finite number, got ${eur}`);
  }
  const cents = BigInt(Math.round(eur * 100));
  const [intPart, fracPart = ''] = satsPerEur.split('.');
  const scaled = BigInt(intPart + fracPart.padEnd(8, '0').slice(0, 8)); // sats × 10^8
  const sats = (cents * scaled) / (100n * 100_000_000n);
  return sats * 1000n;
}
