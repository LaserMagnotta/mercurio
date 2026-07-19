import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeFakeInvoiceForTests, extractPaymentHash } from './bolt11.js';

describe('bolt11 payment_hash round-trip', () => {
  it('recovers an arbitrary 32-byte hash through encode/decode', () => {
    for (let i = 0; i < 50; i++) {
      const hash = randomBytes(32).toString('hex');
      const invoice = encodeFakeInvoiceForTests(hash);
      expect(extractPaymentHash(invoice)).toBe(hash);
    }
  });

  it('recovers the all-zero and all-ff edge cases', () => {
    for (const hash of ['00'.repeat(32), 'ff'.repeat(32)]) {
      expect(extractPaymentHash(encodeFakeInvoiceForTests(hash))).toBe(hash);
    }
  });

  it('is case-insensitive on input', () => {
    const hash = randomBytes(32).toString('hex');
    const invoice = encodeFakeInvoiceForTests(hash).toUpperCase();
    expect(extractPaymentHash(invoice)).toBe(hash);
  });

  it('rejects a string without a bech32 separator', () => {
    expect(() => extractPaymentHash('notaninvoice')).toThrow(/separator/);
  });

  it('rejects an invoice with no payment_hash tag', () => {
    // hrp + separator + a handful of charset-valid words, no tags at all.
    expect(() => extractPaymentHash('lnfake1qqqqqqqqqqqqqq')).toThrow(/payment_hash/);
  });
});
