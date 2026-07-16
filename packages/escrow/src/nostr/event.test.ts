import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { getPublicKeyHex, signEvent, verifyEvent } from './event';

describe('nostr event signing', () => {
  it('signs an event that verifies', () => {
    const sk = bytesToHex(schnorr.utils.randomSecretKey());
    const pubkey = getPublicKeyHex(sk);
    const evt = signEvent(
      { pubkey, created_at: 1_700_000_000, kind: 23194, tags: [['p', 'abc']], content: 'hello' },
      sk,
    );
    expect(verifyEvent(evt)).toBe(true);
  });

  it('rejects a tampered content field', () => {
    const sk = bytesToHex(schnorr.utils.randomSecretKey());
    const pubkey = getPublicKeyHex(sk);
    const evt = signEvent(
      { pubkey, created_at: 1_700_000_000, kind: 23194, tags: [], content: 'original' },
      sk,
    );
    expect(verifyEvent({ ...evt, content: 'tampered' })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const sk1 = bytesToHex(schnorr.utils.randomSecretKey());
    const sk2 = bytesToHex(schnorr.utils.randomSecretKey());
    const pubkey1 = getPublicKeyHex(sk1);
    const evt = signEvent({ pubkey: pubkey1, created_at: 1, kind: 1, tags: [], content: 'x' }, sk2);
    expect(verifyEvent(evt)).toBe(false);
  });
});
