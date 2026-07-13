// Symmetric encryption for wallet connection secrets at rest
// (wallet_connections.connection_secret_encrypted — ARCHITECTURE.md §4).
// Same primitive and key as the preimage vault (AES-256-GCM under
// COORDINATOR_KEY): one operational secret to manage in the MVP. Distinct
// format prefix so the two ciphertext families can never be confused.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_PREFIX = 'box1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function sealSecret(plaintext: string, key: Buffer): string {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return FORMAT_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function openSecret(stored: string, key: Buffer): string {
  assertKey(key);
  if (!stored.startsWith(FORMAT_PREFIX)) {
    throw new Error('unknown secret ciphertext format');
  }
  const blob = Buffer.from(stored.slice(FORMAT_PREFIX.length), 'base64');
  if (blob.length <= IV_BYTES + TAG_BYTES) {
    throw new Error('secret ciphertext too short');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error(`secret-box key must be ${KEY_BYTES} bytes`);
  }
}
