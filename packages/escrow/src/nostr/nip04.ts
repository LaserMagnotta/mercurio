// NIP-04 (legacy) encryption: AES-256-CBC under the raw X-coordinate of the
// secp256k1 ECDH shared point. Deprecated by the spec in favor of NIP-44
// (./nip44.ts) but kept as the fallback for wallets that don't speak it yet
// (ADR-019).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { sharedX } from './ecdh.js';

function sharedKey(privkeyHex: string, pubkeyHex: string): Buffer {
  return Buffer.from(sharedX(privkeyHex, pubkeyHex));
}

export function nip04Encrypt(privkeyHex: string, pubkeyHex: string, plaintext: string): string {
  const key = sharedKey(privkeyHex, pubkeyHex);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${ciphertext.toString('base64')}?iv=${iv.toString('base64')}`;
}

export function nip04Decrypt(privkeyHex: string, pubkeyHex: string, payload: string): string {
  const [ciphertextB64, ivPart] = payload.split('?iv=');
  if (!ciphertextB64 || !ivPart) throw new Error('nip04: malformed payload (missing ?iv=)');
  const key = sharedKey(privkeyHex, pubkeyHex);
  const iv = Buffer.from(ivPart, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
