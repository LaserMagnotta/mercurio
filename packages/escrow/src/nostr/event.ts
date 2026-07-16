// Minimal Nostr event primitives (NIP-01) needed to speak NWC (NIP-47,
// ADR-019): id computation, BIP-340 schnorr signing/verification. No relay
// logic here — see ./relay.ts.

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type UnsignedNostrEvent = Omit<NostrEvent, 'id' | 'sig'>;

export function getPublicKeyHex(secretKeyHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex)));
}

/**
 * NIP-01 canonical serialization: `JSON.stringify` on this exact tuple
 * happens to match the spec's escaping rules (control chars escaped,
 * non-ASCII left as-is, no extra whitespace) — no custom serializer needed.
 */
export function computeEventId(evt: UnsignedNostrEvent): string {
  const serialized = JSON.stringify([
    0,
    evt.pubkey,
    evt.created_at,
    evt.kind,
    evt.tags,
    evt.content,
  ]);
  return bytesToHex(sha256(utf8ToBytes(serialized)));
}

export function signEvent(unsigned: UnsignedNostrEvent, secretKeyHex: string): NostrEvent {
  const id = computeEventId(unsigned);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(secretKeyHex)));
  return { ...unsigned, id, sig };
}

/** Rejects events whose id doesn't match their content or whose signature
 *  doesn't verify — a relay is untrusted transport, never a truth source. */
export function verifyEvent(evt: NostrEvent): boolean {
  const expectedId = computeEventId(evt);
  if (expectedId !== evt.id) return false;
  try {
    return schnorr.verify(hexToBytes(evt.sig), hexToBytes(evt.id), hexToBytes(evt.pubkey));
  } catch {
    return false;
  }
}
