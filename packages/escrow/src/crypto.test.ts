import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CoordinatorKeyError,
  decryptPreimage,
  encryptPreimage,
  generatePreimage,
  loadCoordinatorKey,
} from './crypto';

describe('preimage vault crypto (AES-256-GCM, ADR-013)', () => {
  const key = randomBytes(32);

  it('roundtrips a preimage', () => {
    const { preimageHex } = generatePreimage();
    const stored = encryptPreimage(preimageHex, key);
    expect(stored.startsWith('gcm1:')).toBe(true);
    expect(stored).not.toContain(preimageHex); // never plaintext at rest
    expect(decryptPreimage(stored, key)).toBe(preimageHex);
  });

  it('generates a preimage whose SHA-256 is the payment hash', () => {
    const { preimageHex, hashHex } = generatePreimage();
    const expected = createHash('sha256').update(Buffer.from(preimageHex, 'hex')).digest('hex');
    expect(hashHex).toBe(expected);
    expect(Buffer.from(preimageHex, 'hex')).toHaveLength(32);
  });

  it('every encryption uses a fresh nonce', () => {
    const { preimageHex } = generatePreimage();
    expect(encryptPreimage(preimageHex, key)).not.toBe(encryptPreimage(preimageHex, key));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const { preimageHex } = generatePreimage();
    const stored = encryptPreimage(preimageHex, key);
    const blob = Buffer.from(stored.slice('gcm1:'.length), 'base64');
    blob[blob.length - 1]! ^= 0x01; // flip one ciphertext bit
    const tampered = 'gcm1:' + blob.toString('base64');
    expect(() => decryptPreimage(tampered, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const { preimageHex } = generatePreimage();
    const stored = encryptPreimage(preimageHex, key);
    expect(() => decryptPreimage(stored, randomBytes(32))).toThrow();
  });

  it('rejects unknown storage formats', () => {
    expect(() => decryptPreimage('plaintext-preimage', key)).toThrow(CoordinatorKeyError);
  });

  describe('loadCoordinatorKey', () => {
    it('parses a 64-hex-char COORDINATOR_KEY', () => {
      const hex = randomBytes(32).toString('hex');
      expect(loadCoordinatorKey({ COORDINATOR_KEY: hex })).toEqual(Buffer.from(hex, 'hex'));
    });

    it('fails loudly on missing or malformed keys', () => {
      expect(() => loadCoordinatorKey({})).toThrow(CoordinatorKeyError);
      expect(() => loadCoordinatorKey({ COORDINATOR_KEY: 'abc' })).toThrow(CoordinatorKeyError);
      expect(() => loadCoordinatorKey({ COORDINATOR_KEY: 'z'.repeat(64) })).toThrow(
        CoordinatorKeyError,
      );
    });
  });
});
