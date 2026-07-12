// Preimage vault crypto (ADR-013). The preimage IS the money-moving secret:
// whoever knows it lets the payee settle the hold invoice. It is therefore
// generated here, stored ONLY encrypted (AES-256-GCM, key from the
// COORDINATOR_KEY env var) and decrypted exclusively inside release().
//
// Threat model (ESCROW.md §2): an attacker who dumps the database gets
// ciphertexts only; even with the key, a stolen preimage can only make the
// LEGITIMATE payee collect earlier — the payee of a hold invoice is fixed at
// issuance, so the loot is zero. Encryption at rest is defense in depth, not
// the custody boundary.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Version prefix so the storage format can evolve without a migration. */
const FORMAT_PREFIX = 'gcm1:';
const IV_BYTES = 12; // AES-GCM standard nonce size
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PREIMAGE_BYTES = 32; // Lightning payment preimages are exactly 32 bytes

export class CoordinatorKeyError extends Error {}

/**
 * Parses COORDINATOR_KEY (64 hex chars = 32 bytes). Generate one with:
 * `openssl rand -hex 32`. Fails loudly: a coordinator silently running with
 * a bad key could mint payments whose preimages can never be released.
 */
export function loadCoordinatorKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.COORDINATOR_KEY;
  if (!raw) {
    throw new CoordinatorKeyError('COORDINATOR_KEY is not set (expected 64 hex chars)');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new CoordinatorKeyError('COORDINATOR_KEY must be exactly 64 hex chars (32 bytes)');
  }
  return Buffer.from(raw, 'hex');
}

/** Fresh 32-byte preimage + its SHA-256 payment hash, both lowercase hex. */
export function generatePreimage(): { preimageHex: string; hashHex: string } {
  const preimage = randomBytes(PREIMAGE_BYTES);
  return { preimageHex: preimage.toString('hex'), hashHex: sha256Hex(preimage) };
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** AES-256-GCM; output is `gcm1:` + base64(iv || tag || ciphertext). */
export function encryptPreimage(preimageHex: string, key: Buffer): string {
  assertKey(key);
  const plaintext = Buffer.from(preimageHex, 'hex');
  if (plaintext.length !== PREIMAGE_BYTES) {
    throw new CoordinatorKeyError(`preimage must be ${PREIMAGE_BYTES} bytes`);
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FORMAT_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Rejects tampered ciphertexts (GCM auth tag) and unknown formats. */
export function decryptPreimage(stored: string, key: Buffer): string {
  assertKey(key);
  if (!stored.startsWith(FORMAT_PREFIX)) {
    throw new CoordinatorKeyError('unknown preimage ciphertext format');
  }
  const blob = Buffer.from(stored.slice(FORMAT_PREFIX.length), 'base64');
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new CoordinatorKeyError('preimage ciphertext too short');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('hex');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new CoordinatorKeyError(`coordinator key must be ${KEY_BYTES} bytes`);
  }
}
