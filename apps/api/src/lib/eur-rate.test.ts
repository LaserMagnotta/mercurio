// eurFloatToMsat backs the suggestion endpoints (suggested offer / carrier
// rate): it prefills sats-first inputs, so its rounding must be exact and
// deterministic (ADR-008 — EUR only at input/display, floor to whole sat).

import { describe, expect, it } from 'vitest';
import { eurFloatToMsat, eurToMsat, msatPerEur } from './eur-rate.js';

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
