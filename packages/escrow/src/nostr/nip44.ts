// NIP-44 v2 encryption (preferred scheme per NIP-47's encryption negotiation,
// ADR-019): secp256k1 ECDH -> HKDF -> ChaCha20 -> HMAC-SHA256, custom padding.
// Implemented from the NIP-44 spec (nostr-protocol/nips/44.md); no external
// nostr library — only the @noble/* primitives already used by ./nip04.ts.
//
// Scope: we only need to talk to NWC wallet SERVICES (never end users), whose
// JSON-RPC payloads are always small. We support the standard two-byte
// length-prefix path (plaintext up to 65535 bytes) and reject anything
// larger rather than guess at a larger, less certain extended-length framing.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chacha20 } from '@noble/ciphers/chacha.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { sharedX } from './ecdh.js';

const MIN_PLAINTEXT_BYTES = 1;
const MAX_PLAINTEXT_BYTES = 0xffff;
const NONCE_BYTES = 32;
const MAC_BYTES = 32;
const VERSION = 2;

function getConversationKey(privkeyHex: string, pubkeyHex: string): Uint8Array {
  return extract(sha256, sharedX(privkeyHex, pubkeyHex), utf8ToBytes('nip44-v2'));
}

function getMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array) {
  const expanded = expand(sha256, conversationKey, nonce, 76);
  return {
    chachaKey: expanded.subarray(0, 32),
    chachaNonce: expanded.subarray(32, 44),
    hmacKey: expanded.subarray(44, 76),
  };
}

function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 1 << (Math.floor(Math.log2(unpaddedLen - 1)) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

function pad(plaintext: string): Uint8Array {
  const unpadded = utf8ToBytes(plaintext);
  const len = unpadded.length;
  if (len < MIN_PLAINTEXT_BYTES || len > MAX_PLAINTEXT_BYTES) {
    throw new Error(
      `nip44: plaintext length ${len} outside [${MIN_PLAINTEXT_BYTES}, ${MAX_PLAINTEXT_BYTES}]`,
    );
  }
  const prefix = new Uint8Array(2);
  new DataView(prefix.buffer).setUint16(0, len, false);
  const suffix = new Uint8Array(calcPaddedLen(len) - len);
  return concatBytes(prefix, unpadded, suffix);
}

function unpad(padded: Uint8Array): string {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint16(0, false);
  const unpadded = padded.subarray(2, 2 + len);
  if (len === 0 || unpadded.length !== len || padded.length !== 2 + calcPaddedLen(len)) {
    throw new Error('nip44: invalid padding');
  }
  return Buffer.from(unpadded).toString('utf8');
}

function hmacAad(key: Uint8Array, message: Uint8Array, aad: Uint8Array): Uint8Array {
  if (aad.length !== NONCE_BYTES) throw new Error('nip44: aad must be 32 bytes');
  return hmac(sha256, key, concatBytes(aad, message));
}

export function nip44Encrypt(
  privkeyHex: string,
  pubkeyHex: string,
  plaintext: string,
  nonce: Uint8Array = randomBytes(NONCE_BYTES),
): string {
  const conversationKey = getConversationKey(privkeyHex, pubkeyHex);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const padded = pad(plaintext);
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = hmacAad(hmacKey, ciphertext, nonce);
  const payload = concatBytes(new Uint8Array([VERSION]), nonce, ciphertext, mac);
  return Buffer.from(payload).toString('base64');
}

export function nip44Decrypt(privkeyHex: string, pubkeyHex: string, payload: string): string {
  const bytes = new Uint8Array(Buffer.from(payload, 'base64'));
  if (bytes.length < 1 + NONCE_BYTES + MAC_BYTES) throw new Error('nip44: payload too short');
  if (bytes[0] !== VERSION) throw new Error(`nip44: unsupported version ${bytes[0]}`);
  const nonce = bytes.subarray(1, 1 + NONCE_BYTES);
  const mac = bytes.subarray(bytes.length - MAC_BYTES);
  const ciphertext = bytes.subarray(1 + NONCE_BYTES, bytes.length - MAC_BYTES);

  const conversationKey = getConversationKey(privkeyHex, pubkeyHex);
  const { chachaKey, chachaNonce, hmacKey } = getMessageKeys(conversationKey, nonce);
  const expectedMac = hmacAad(hmacKey, ciphertext, nonce);
  if (!timingSafeEqual(Buffer.from(expectedMac), Buffer.from(mac))) {
    throw new Error('nip44: invalid MAC');
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return unpad(padded);
}
