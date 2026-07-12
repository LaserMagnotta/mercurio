// Hash-concatenated custody chain (ARCHITECTURE.md §4, custody_events table).
// Pure computation only — sha256 over canonical bytes is not I/O, so it is
// allowed in @mercurio/core. The API persists the rows; these helpers make
// two machines (or the API and an auditor) agree on every hash.

import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted at every depth, bigint rendered as its
 * decimal-string representation (payloads carry msat amounts, JSON has no
 * bigint), no undefined values (dropped, as JSON.stringify does). Rejects
 * non-finite numbers: a NaN in a custody payload is a bug, not data.
 * Canonicalization is one-way (for hashing) — round-tripping is not a goal,
 * so bigint-as-string is acceptable and keeps payloads human-readable.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString());
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number ${value}`);
      }
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError('canonicalJson: cannot canonicalize a top-level undefined');
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}

/** The fields that are hashed — the identity-bearing columns of custody_events. */
export interface CustodyEventInput {
  shipmentId: string;
  type: string;
  actorUserId: string | null;
  legId: string | null;
  hubStayId: string | null;
  payload: Record<string, unknown>;
  /** ISO 8601 UTC — assigned by the API when it appends the row. */
  createdAt: string;
}

/**
 * hash = sha256( prev_event_hash ⧺ canonical(event) ). The previous hash is
 * part of the preimage, so rewriting any past row invalidates every hash
 * after it: the chain is the tamper-evidence that replaces an arbiter's
 * authority (ADR-012). The first event of a shipment has no predecessor;
 * a fixed sentinel keeps the preimage layout uniform.
 */
export function custodyEventHash(event: CustodyEventInput, prevEventHash: string | null): string {
  const canonical = canonicalJson({
    shipmentId: event.shipmentId,
    type: event.type,
    actorUserId: event.actorUserId,
    legId: event.legId,
    hubStayId: event.hubStayId,
    payload: event.payload,
    createdAt: event.createdAt,
  });
  return createHash('sha256')
    .update(`${prevEventHash ?? 'genesis'}\n${canonical}`)
    .digest('hex');
}

export type ChainVerification =
  | { valid: true }
  | { valid: false; index: number; reason: 'broken_link' | 'hash_mismatch' | 'dangling_first_link' };

/**
 * Verify a shipment's full chain, in insertion order. Returns the index of
 * the first bad row: either its prev_event_hash does not match the previous
 * row's hash (or is non-null on the first row), or its own hash does not
 * recompute from its content.
 */
export function verifyCustodyChain(
  events: readonly (CustodyEventInput & { prevEventHash: string | null; hash: string })[],
): ChainVerification {
  let prevHash: string | null = null;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.prevEventHash !== prevHash) {
      return { valid: false, index: i, reason: i === 0 ? 'dangling_first_link' : 'broken_link' };
    }
    if (custodyEventHash(event, event.prevEventHash) !== event.hash) {
      return { valid: false, index: i, reason: 'hash_mismatch' };
    }
    prevHash = event.hash;
  }
  return { valid: true };
}
