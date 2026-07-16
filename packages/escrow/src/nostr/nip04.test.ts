import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nip04Decrypt, nip04Encrypt } from './nip04';

function keypair() {
  const secretKey = schnorr.utils.randomSecretKey();
  return { sk: bytesToHex(secretKey), pk: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

describe('nip04', () => {
  it('round-trips plaintext between two parties', () => {
    const alice = keypair();
    const bob = keypair();
    const payload = nip04Encrypt(alice.sk, bob.pk, 'hello bob');
    expect(nip04Decrypt(bob.sk, alice.pk, payload)).toBe('hello bob');
  });

  it('produces a fresh IV (and payload) each call', () => {
    const alice = keypair();
    const bob = keypair();
    const a = nip04Encrypt(alice.sk, bob.pk, 'same message');
    const b = nip04Encrypt(alice.sk, bob.pk, 'same message');
    expect(a).not.toBe(b);
  });

  it('rejects a payload missing the ?iv= marker', () => {
    const alice = keypair();
    const bob = keypair();
    expect(() => nip04Decrypt(bob.sk, alice.pk, 'not-a-real-payload')).toThrow(/iv/);
  });
});
