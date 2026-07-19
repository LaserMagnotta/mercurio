import { describe, expect, it } from 'vitest';
import { hubFeePercentToBp } from './economics.js';

describe('hubFeePercentToBp', () => {
  it('converts numeric(5,2) strings losslessly', () => {
    expect(hubFeePercentToBp('10.00')).toBe(1000);
    expect(hubFeePercentToBp('0.01')).toBe(1);
    expect(hubFeePercentToBp('12.5')).toBe(1250);
    expect(hubFeePercentToBp('100')).toBe(10000);
    expect(hubFeePercentToBp('0')).toBe(0);
  });

  it('accepts plain numbers with at most two decimals', () => {
    expect(hubFeePercentToBp(10)).toBe(1000);
    expect(hubFeePercentToBp(12.5)).toBe(1250);
    expect(hubFeePercentToBp(0.25)).toBe(25);
  });

  it('rejects anything that would lose precision or is out of range', () => {
    // Rejecting (not rounding) sub-bp precision: a hub configured 12.345% must
    // not silently become 12.34% — fees are contractual amounts.
    expect(() => hubFeePercentToBp('12.345')).toThrow(RangeError);
    expect(() => hubFeePercentToBp(12.345)).toThrow(RangeError);
    expect(() => hubFeePercentToBp('-5')).toThrow(RangeError);
    expect(() => hubFeePercentToBp('100.01')).toThrow(RangeError);
    expect(() => hubFeePercentToBp('1e2')).toThrow(RangeError);
    expect(() => hubFeePercentToBp(Number.NaN)).toThrow(RangeError);
    expect(() => hubFeePercentToBp('')).toThrow(RangeError);
  });
});
