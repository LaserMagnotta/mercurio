import { describe, expect, it } from 'vitest';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nip44Decrypt, nip44Encrypt } from './nip44';

function keypair() {
  const secretKey = schnorr.utils.randomSecretKey();
  return { sk: bytesToHex(secretKey), pk: bytesToHex(schnorr.getPublicKey(secretKey)) };
}

describe('nip44 v2', () => {
  it('round-trips a short JSON-RPC-shaped plaintext', () => {
    const alice = keypair();
    const bob = keypair();
    const plaintext = JSON.stringify({ method: 'get_info', params: {} });
    const payload = nip44Encrypt(alice.sk, bob.pk, plaintext);
    expect(nip44Decrypt(bob.sk, alice.pk, payload)).toBe(plaintext);
  });

  it('round-trips across the padding bucket boundaries (1..300 bytes)', () => {
    const alice = keypair();
    const bob = keypair();
    for (const len of [1, 31, 32, 33, 64, 96, 100, 200, 255, 256, 300]) {
      const plaintext = 'x'.repeat(len);
      const payload = nip44Encrypt(alice.sk, bob.pk, plaintext);
      expect(nip44Decrypt(bob.sk, alice.pk, payload)).toBe(plaintext);
    }
  });

  it('is symmetric: either party can decrypt what the other encrypted', () => {
    const alice = keypair();
    const bob = keypair();
    const payload = nip44Encrypt(bob.sk, alice.pk, 'from bob');
    expect(nip44Decrypt(alice.sk, bob.pk, payload)).toBe('from bob');
  });

  it('produces a fresh nonce (and payload) each call', () => {
    const alice = keypair();
    const bob = keypair();
    const a = nip44Encrypt(alice.sk, bob.pk, 'same message');
    const b = nip44Encrypt(alice.sk, bob.pk, 'same message');
    expect(a).not.toBe(b);
  });

  it('rejects a payload tampered after encryption (bad MAC)', () => {
    const alice = keypair();
    const bob = keypair();
    const payload = nip44Encrypt(alice.sk, bob.pk, 'integrity please');
    const bytes = Buffer.from(payload, 'base64');
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff; // flip a bit in the MAC
    const tampered = bytes.toString('base64');
    expect(() => nip44Decrypt(bob.sk, alice.pk, tampered)).toThrow(/MAC/);
  });

  it('rejects decryption by an unrelated third party', () => {
    const alice = keypair();
    const bob = keypair();
    const mallory = keypair();
    const payload = nip44Encrypt(alice.sk, bob.pk, 'not for you');
    expect(() => nip44Decrypt(mallory.sk, alice.pk, payload)).toThrow();
  });
});
