// Amount formatting (ADR-008): sats are exact bigint math; the EUR line is
// indicative, derived from the API-provided snapshot, rounded to the cent.

import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatEurIndicative,
  formatKm,
  formatSats,
  msatToSats,
  satsToMsat,
} from '../format';

const eur = (n: number, locale = 'it') =>
  new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(n);

describe('msatToSats', () => {
  it('floors sub-sat remainders', () => {
    expect(msatToSats('8000000')).toBe(8000n);
    expect(msatToSats('8000999')).toBe(8000n);
    expect(msatToSats('999')).toBe(0n);
  });

  it('rejects non-msat strings', () => {
    expect(() => msatToSats('')).toThrow(RangeError);
    expect(() => msatToSats('-5')).toThrow(RangeError);
    expect(() => msatToSats('1.5')).toThrow(RangeError);
    expect(() => msatToSats('abc')).toThrow(RangeError);
  });
});

describe('satsToMsat', () => {
  it('is the exact ×1000 unit conversion', () => {
    expect(satsToMsat(8000n)).toBe('8000000');
    expect(satsToMsat(0n)).toBe('0');
  });

  it('rejects negatives', () => {
    expect(() => satsToMsat(-1n)).toThrow(RangeError);
  });
});

describe('formatSats', () => {
  it('groups thousands per locale', () => {
    expect(formatSats('8000000', 'it')).toBe(new Intl.NumberFormat('it').format(8000));
    expect(formatSats('8000000', 'en')).toBe(new Intl.NumberFormat('en').format(8000));
  });
});

describe('formatEurIndicative', () => {
  it('converts at the snapshot and rounds to the cent', () => {
    // 8000 sats at 1600 sats/€ = 5.00 €
    expect(formatEurIndicative('8000000', '1600', 'it')).toBe(eur(5));
    // 1234 sats at 1600 sats/€ = 0.77125 € → 0.77 €
    expect(formatEurIndicative('1234000', '1600', 'it')).toBe(eur(0.77));
  });

  it('honors decimal rates', () => {
    // 1600.5 sats/€: 1600.5 sats → exactly 1 €
    expect(formatEurIndicative('1600500', '1600.5', 'it')).toBe(eur(1));
  });

  it('returns null on a missing or malformed rate (sats-only display)', () => {
    expect(formatEurIndicative('8000000', null, 'it')).toBeNull();
    expect(formatEurIndicative('8000000', undefined, 'it')).toBeNull();
    expect(formatEurIndicative('8000000', 'abc', 'it')).toBeNull();
    expect(formatEurIndicative('8000000', '0', 'it')).toBeNull();
  });
});

describe('formatSatsPerEur', () => {
  it('trims numeric-column trailing zeros', async () => {
    const { formatSatsPerEur } = await import('../format');
    expect(formatSatsPerEur('1600.00000000')).toBe('1600');
    expect(formatSatsPerEur('1600.50000000')).toBe('1600.5');
    expect(formatSatsPerEur('1600')).toBe('1600');
  });
});

describe('formatKm / formatDateTime', () => {
  it('formats km with at most one decimal', () => {
    expect(formatKm(12.34, 'it')).toBe(
      `${new Intl.NumberFormat('it', { maximumFractionDigits: 1 }).format(12.34)} km`,
    );
    expect(formatKm(100, 'it')).toBe('100 km');
  });

  it('formats ISO timestamps without throwing', () => {
    expect(formatDateTime('2026-07-14T12:00:00.000Z', 'it')).toBeTruthy();
  });
});

describe('formatPercent', () => {
  it('drops numeric-column trailing zeros, keeps real decimals per locale', async () => {
    const { formatPercent } = await import('../format');
    expect(formatPercent('10.00', 'it')).toBe('10');
    expect(formatPercent('12.50', 'it')).toBe('12,5');
    expect(formatPercent('not-a-number', 'it')).toBe('not-a-number');
  });
});
