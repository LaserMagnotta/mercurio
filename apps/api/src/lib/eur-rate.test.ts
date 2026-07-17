// eurFloatToMsat backs the suggestion endpoints (suggested offer / carrier
// rate): it prefills sats-first inputs, so its rounding must be exact and
// deterministic (ADR-008 — EUR only at input/display, floor to whole sat).
//
// The market provider (ADR-025) is exercised with an INJECTED fetch: this
// suite never touches the network, and never needs to — every interesting
// case is a feed misbehaving, which is easier to stage than to wait for.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvEurRateProvider,
  createEurRateProviderFromEnv,
  createMarketEurRateProvider,
  eurFloatToMsat,
  eurPerBtcToSatsPerEur,
  eurToMsat,
  EurRateUnavailableError,
  MARKET_SOURCES,
  msatPerEur,
  type HttpFetch,
  type MarketEurRateConfig,
} from './eur-rate.js';

describe('eurToMsat (whole EUR, ToS caps)', () => {
  it('converts whole EUR at an integer rate', () => {
    expect(eurToMsat(5, '1600')).toBe(8_000_000n); // the canonical 5 € offer
    expect(eurToMsat(0, '1600')).toBe(0n);
  });

  it('honors decimal rates to 8 places', () => {
    expect(eurToMsat(1, '1600.5')).toBe(1_600_500n);
  });

  it('rejects fractional or negative input', () => {
    expect(() => eurToMsat(1.5, '1600')).toThrow(RangeError);
    expect(() => eurToMsat(-1, '1600')).toThrow(RangeError);
  });
});

describe('eurFloatToMsat (suggestion anchors)', () => {
  it('matches eurToMsat on whole amounts', () => {
    expect(eurFloatToMsat(5, '1600')).toBe(eurToMsat(5, '1600'));
  });

  it('quantizes to cents, then floors to a whole sat', () => {
    // 5.23 € × 1600 sats/€ = 8368 sats exactly.
    expect(eurFloatToMsat(5.23, '1600')).toBe(8_368_000n);
    // 0.333… € rounds to 33 cents; 33 × 1600 / 100 = 528 sats.
    expect(eurFloatToMsat(1 / 3, '1600')).toBe(528_000n);
    // Fractional-sat results floor: 33 cents × 1600.5/100 = 528.165 → 528.
    expect(eurFloatToMsat(0.33, '1600.5')).toBe(528_000n);
  });

  it('always returns whole sats (msat multiple of 1000)', () => {
    for (const eur of [0.01, 0.2, 1.99, 7.77, 123.45]) {
      expect(eurFloatToMsat(eur, '1600.12345678') % 1000n).toBe(0n);
    }
  });

  it('rejects negative and non-finite input', () => {
    expect(() => eurFloatToMsat(-0.01, '1600')).toThrow(RangeError);
    expect(() => eurFloatToMsat(Number.NaN, '1600')).toThrow(RangeError);
    expect(() => eurFloatToMsat(Number.POSITIVE_INFINITY, '1600')).toThrow(RangeError);
  });
});

describe('msatPerEur', () => {
  it('is eurToMsat of 1 EUR', () => {
    expect(msatPerEur('1600')).toBe(1_600_000n);
    expect(msatPerEur('1600.5')).toBe(1_600_500n);
  });
});

describe('eurPerBtcToSatsPerEur (a feed quote → a snapshot rate)', () => {
  it('inverts EUR/BTC into sats/EUR in integer math', () => {
    // The historical placeholder is exactly this price: a useful touchstone.
    expect(eurPerBtcToSatsPerEur('62500')).toBe('1600.00000000');
    expect(eurPerBtcToSatsPerEur('50000')).toBe('2000.00000000');
    expect(eurPerBtcToSatsPerEur('12500')).toBe('8000.00000000');
    // Fractional quotes (all three feeds publish decimal strings).
    expect(eurPerBtcToSatsPerEur('62500.00000000')).toBe('1600.00000000');
    expect(eurPerBtcToSatsPerEur('1600000')).toBe('62.50000000');
  });

  it('truncates downwards at the 8th decimal, never rounds up', () => {
    // 10^8 / 3_000_000 = 33.333… → the repeating tail is cut, not rounded.
    expect(eurPerBtcToSatsPerEur('3000000')).toBe('33.33333333');
  });

  it('produces a rate the existing integer math accepts unchanged', () => {
    const rate = eurPerBtcToSatsPerEur('54929');
    expect(rate).toMatch(/^\d{1,10}\.\d{8}$/);
    // The whole point of the string format: it flows into the frozen snapshot
    // and back out through the money math without a float in sight.
    expect(eurToMsat(1, rate!)).toBe(msatPerEur(rate!));
    expect(eurFloatToMsat(1, rate!) % 1000n).toBe(0n);
  });

  it('rejects anything that is not a plain decimal quote', () => {
    for (const junk of ['', 'N/A', 'null', '1e5', '-54929', '54,929.08', '54929.08.1', ' 54929']) {
      expect(eurPerBtcToSatsPerEur(junk)).toBeNull();
    }
  });

  it('rejects quotes outside the sanity bounds (a broken feed, not a price)', () => {
    expect(eurPerBtcToSatsPerEur('0')).toBeNull();
    expect(eurPerBtcToSatsPerEur('999.99999999')).toBeNull();
    expect(eurPerBtcToSatsPerEur('10000000.00000001')).toBeNull();
    expect(eurPerBtcToSatsPerEur('999999999999')).toBeNull();
    // The bounds themselves are inclusive.
    expect(eurPerBtcToSatsPerEur('1000')).toBe('100000.00000000');
    expect(eurPerBtcToSatsPerEur('10000000')).toBe('10.00000000');
  });
});

// --- Market provider (ADR-025) ----------------------------------------------
//
// The bodies below are the shapes recorded from the live endpoints on
// 2026-07-17, with the price swapped in: if a feed ever renames the field we
// read, these fixtures are what tells us the parser — not production.

type SourceName = 'kraken' | 'bitstamp' | 'coinbase';
type Outcome = { json: unknown } | 'down' | 'http-500';

const SOURCES = Object.values(MARKET_SOURCES);

const krakenAt = (price: string): Outcome => ({
  json: { error: [], result: { XXBTZEUR: { c: [price, '0.00010631'], v: ['1.0', '2.0'] } } },
});
const bitstampAt = (price: string): Outcome => ({
  json: { timestamp: '1784294148', last: price, bid: price, ask: price, volume: '128.43' },
});
const coinbaseAt = (price: string): Outcome => ({
  json: { data: { amount: price, base: 'BTC', currency: 'EUR' } },
});

describe('createMarketEurRateProvider', () => {
  let clock: Date;

  beforeEach(() => {
    clock = new Date('2026-07-17T12:00:00.000Z');
  });

  /** `outcomes` is read at call time: a test can take the feeds down midway
   *  by mutating it, which is exactly the interesting scenario. */
  function build(outcomes: Record<SourceName, Outcome>, opts: Partial<MarketEurRateConfig> = {}) {
    let calls = 0;
    const fetch: HttpFetch = async (url) => {
      calls += 1;
      const found = Object.entries(MARKET_SOURCES).find(([, source]) => source.url === url);
      if (!found) throw new Error(`unexpected url ${url}`);
      const outcome = outcomes[found[0] as SourceName];
      if (outcome === 'down') throw new Error('ECONNREFUSED');
      if (outcome === 'http-500') return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => outcome.json };
    };
    const provider = createMarketEurRateProvider({
      sources: SOURCES,
      fetch,
      now: () => clock,
      ...opts,
    });
    return { provider, calls: () => calls };
  }

  const allAgreeing = (): Record<SourceName, Outcome> => ({
    kraken: krakenAt('50000'),
    bitstamp: bitstampAt('50000'),
    coinbase: coinbaseAt('50000'),
  });

  it('takes the median of the sources and records which ones backed it', async () => {
    // Note the inversion: the HIGHEST €/BTC quote is the LOWEST sats/€, so a
    // median taken on sats/€ still lands on the middle source (62500 → 1600,
    // 50000 → 2000, 40000 → 2500).
    const { provider } = build({
      kraken: krakenAt('40000'),
      bitstamp: bitstampAt('50000'),
      coinbase: coinbaseAt('62500'),
    });
    const snap = await provider.snapshot('freeze');
    expect(snap.satsPerEur).toBe('2000.00000000');
    expect(snap.source).toBe('median(bitstamp,coinbase,kraken)');
    expect(snap.at).toEqual(clock);
  });

  it('discards a source that lies WITHIN the sanity bounds (the median, not the bounds)', async () => {
    // A ×100 unit error at 50 000 €/BTC is 5 M€/BTC: still inside the bounds,
    // so only corroboration catches it (ADR-025 §4).
    const { provider } = build({
      kraken: krakenAt('5000000'),
      bitstamp: bitstampAt('50000'),
      coinbase: coinbaseAt('50000'),
    });
    expect((await provider.snapshot()).satsPerEur).toBe('2000.00000000');
  });

  it('drops a malformed body and answers on the remaining quorum', async () => {
    const { provider } = build({
      kraken: { json: { error: ['EQuery:Unknown asset pair'], result: {} } },
      bitstamp: bitstampAt('50000'),
      coinbase: coinbaseAt('50000'),
    });
    const snap = await provider.snapshot();
    expect(snap.satsPerEur).toBe('2000.00000000');
    expect(snap.source).toBe('median(bitstamp,coinbase)');
  });

  const badFeeds: [string, Outcome][] = [
    ['a body of the wrong shape', { json: { unexpected: true } }],
    ['a null body', { json: null }],
    ['a number where a decimal string belongs', { json: { last: 50000 } }],
    ['an out-of-bounds quote', bitstampAt('0')],
    ['a non-2xx response', 'http-500'],
    ['an unreachable host', 'down'],
  ];

  it.each(badFeeds)('drops %s', async (_label, bad) => {
    const { provider } = build({ ...allAgreeing(), bitstamp: bad });
    const snap = await provider.snapshot();
    expect(snap.satsPerEur).toBe('2000.00000000');
    expect(snap.source).toBe('median(coinbase,kraken)');
  });

  it('fails the refresh below the quorum: one source is not corroboration', async () => {
    const { provider } = build({
      kraken: 'http-500',
      bitstamp: 'down',
      coinbase: coinbaseAt('50000'),
    });
    await expect(provider.snapshot()).rejects.toThrow(EurRateUnavailableError);
  });

  it('throws for both uses when the feeds are down and nothing is cached', async () => {
    const { provider } = build({ kraken: 'down', bitstamp: 'down', coinbase: 'down' });
    await expect(provider.snapshot('freeze')).rejects.toThrow(EurRateUnavailableError);
    await expect(provider.snapshot('suggest')).rejects.toThrow(EurRateUnavailableError);
  });

  it('serves the cache within the TTL without refetching', async () => {
    const { provider, calls } = build(allAgreeing(), { ttlMs: 5 * 60_000 });
    const first = await provider.snapshot();
    expect(calls()).toBe(3);

    clock = new Date(clock.getTime() + 4 * 60_000);
    const second = await provider.snapshot();
    expect(calls()).toBe(3); // no second round
    expect(second.at).toEqual(first.at); // and `at` still says when it was read
  });

  it('refetches once the TTL has expired', async () => {
    const outcomes = allAgreeing();
    const { provider, calls } = build(outcomes, { ttlMs: 5 * 60_000 });
    expect((await provider.snapshot()).satsPerEur).toBe('2000.00000000');

    outcomes.kraken = krakenAt('62500');
    outcomes.bitstamp = bitstampAt('62500');
    outcomes.coinbase = coinbaseAt('62500');
    clock = new Date(clock.getTime() + 6 * 60_000);

    const fresh = await provider.snapshot();
    expect(calls()).toBe(6);
    expect(fresh.satsPerEur).toBe('1600.00000000');
    expect(fresh.at).toEqual(clock);
  });

  it('shares one round of fetches between concurrent callers', async () => {
    const { provider, calls } = build(allAgreeing());
    const [a, b, c] = await Promise.all([
      provider.snapshot(),
      provider.snapshot(),
      provider.snapshot('suggest'),
    ]);
    expect(calls()).toBe(3); // one round of three sources, not three rounds
    expect(a.satsPerEur).toBe(b.satsPerEur);
    expect(b.satsPerEur).toBe(c.satsPerEur);
  });

  it('freezes a stale-but-young rate when the feeds are down', async () => {
    const outcomes = allAgreeing();
    const { provider } = build(outcomes, { ttlMs: 5 * 60_000, maxAgeMs: 6 * 60 * 60_000 });
    const first = await provider.snapshot();

    outcomes.kraken = 'down';
    outcomes.bitstamp = 'down';
    outcomes.coinbase = 'down';
    clock = new Date(clock.getTime() + 60 * 60_000); // 1h: past the TTL, inside the max age

    const stale = await provider.snapshot('freeze');
    expect(stale.satsPerEur).toBe('2000.00000000');
    // The snapshot must not pretend it is current: `at` is when the price was
    // observed, an hour ago, and that is what a shipment would record.
    expect(stale.at).toEqual(first.at);
  });

  it('refuses to freeze a rate past the max age, and defaults to that policy', async () => {
    const outcomes = allAgreeing();
    const { provider } = build(outcomes, { maxAgeMs: 6 * 60 * 60_000 });
    await provider.snapshot();

    outcomes.kraken = 'down';
    outcomes.bitstamp = 'down';
    outcomes.coinbase = 'down';
    clock = new Date(clock.getTime() + 7 * 60 * 60_000);

    // No argument: the default use is the strict one.
    await expect(provider.snapshot()).rejects.toThrow(EurRateUnavailableError);
    await expect(provider.snapshot('freeze')).rejects.toThrow(EurRateUnavailableError);
  });

  it('still suggests from a rate too old to freeze: a hint is not a contract', async () => {
    const outcomes = allAgreeing();
    const { provider } = build(outcomes, { maxAgeMs: 6 * 60 * 60_000 });
    const first = await provider.snapshot();

    outcomes.kraken = 'down';
    outcomes.bitstamp = 'down';
    outcomes.coinbase = 'down';
    clock = new Date(clock.getTime() + 48 * 60 * 60_000);

    const suggestion = await provider.snapshot('suggest');
    expect(suggestion.satsPerEur).toBe('2000.00000000');
    expect(suggestion.at).toEqual(first.at);
  });

  it('refuses to be built with fewer sources than the quorum', () => {
    const fetch: HttpFetch = async () => {
      throw new Error('must not be called');
    };
    expect(() => createMarketEurRateProvider({ sources: [SOURCES[0]!], fetch })).toThrow(/quorum/);
  });
});

describe('createEurRateProviderFromEnv', () => {
  it('defaults to the fixed provider: nothing reaches the network unasked', async () => {
    const snap = await createEurRateProviderFromEnv({}).snapshot();
    expect(snap.satsPerEur).toBe('1600');
    expect(snap.source).toBe('env-fixed');
  });

  it('honors an explicit fixed rate', async () => {
    const provider = createEurRateProviderFromEnv({
      EUR_RATE_PROVIDER: 'fixed',
      EUR_RATE_SATS_PER_EUR: '1821',
    });
    expect((await provider.snapshot()).satsPerEur).toBe('1821');
  });

  it('rejects a malformed fixed rate', () => {
    expect(() => createEnvEurRateProvider({ EUR_RATE_SATS_PER_EUR: 'a lot' })).toThrow();
  });

  // These build the real provider (real URLs, real parsers) but never call
  // snapshot(): construction alone must not fetch, which is also what keeps
  // this suite off the network.
  it('builds the market provider with every known source by default', () => {
    expect(() => createEurRateProviderFromEnv({ EUR_RATE_PROVIDER: 'market' })).not.toThrow();
  });

  it('honors an explicit source list', () => {
    expect(() =>
      createEurRateProviderFromEnv({
        EUR_RATE_PROVIDER: 'market',
        EUR_RATE_SOURCES: 'kraken, bitstamp',
      }),
    ).not.toThrow();
  });

  it('rejects a source list too short to corroborate', () => {
    expect(() =>
      createEurRateProviderFromEnv({ EUR_RATE_PROVIDER: 'market', EUR_RATE_SOURCES: 'kraken' }),
    ).toThrow(/quorum/);
  });

  it('rejects an unknown source instead of silently ignoring it', () => {
    expect(() =>
      createEurRateProviderFromEnv({
        EUR_RATE_PROVIDER: 'market',
        EUR_RATE_SOURCES: 'kraken,mtgox',
      }),
    ).toThrow(/mtgox/);
  });

  it('rejects an unknown provider', () => {
    expect(() => createEurRateProviderFromEnv({ EUR_RATE_PROVIDER: 'vibes' })).toThrow(/vibes/);
  });
});
