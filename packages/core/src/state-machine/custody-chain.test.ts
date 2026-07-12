import { describe, expect, it } from 'vitest';
import type { CustodyEventInput } from './custody-chain';
import { canonicalJson, custodyEventHash, verifyCustodyChain } from './custody-chain';

const baseEvent: CustodyEventInput = {
  shipmentId: 'ship-1',
  type: 'created',
  actorUserId: 'user-1',
  legId: null,
  hubStayId: null,
  payload: { offerMsat: 8_000_000n, originHubId: 'hub-a' },
  createdAt: '2026-07-12T08:00:00.000Z',
};

describe('canonicalJson', () => {
  it('is independent of key insertion order at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('renders bigint as a decimal string (payloads carry msat amounts)', () => {
    expect(canonicalJson({ amount: 123n })).toBe('{"amount":"123"}');
  });

  it('drops undefined object values, keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
  });
});

describe('custodyEventHash', () => {
  it('is deterministic and 64 hex chars', () => {
    const h1 = custodyEventHash(baseEvent, null);
    const h2 = custodyEventHash({ ...baseEvent, payload: { originHubId: 'hub-a', offerMsat: 8_000_000n } }, null);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any hashed field changes, including the previous hash', () => {
    const h = custodyEventHash(baseEvent, null);
    expect(custodyEventHash({ ...baseEvent, type: 'funded' }, null)).not.toBe(h);
    expect(custodyEventHash({ ...baseEvent, payload: { ...baseEvent.payload, offerMsat: 8_000_001n } }, null)).not.toBe(h);
    expect(custodyEventHash(baseEvent, h)).not.toBe(h);
  });
});

describe('verifyCustodyChain', () => {
  function buildChain(length: number) {
    const events = [];
    let prev: string | null = null;
    for (let i = 0; i < length; i += 1) {
      const input: CustodyEventInput = {
        ...baseEvent,
        type: i === 0 ? 'created' : 'funded',
        payload: { seq: i },
        createdAt: new Date(Date.parse(baseEvent.createdAt) + i * 60_000).toISOString(),
      };
      const hash = custodyEventHash(input, prev);
      events.push({ ...input, prevEventHash: prev, hash });
      prev = hash;
    }
    return events;
  }

  it('accepts a well-formed chain (and the empty chain)', () => {
    expect(verifyCustodyChain(buildChain(5))).toEqual({ valid: true });
    expect(verifyCustodyChain([])).toEqual({ valid: true });
  });

  it('rewriting a past event invalidates it and breaks the link after it', () => {
    const chain = buildChain(5);
    chain[2] = { ...chain[2]!, payload: { seq: 99 } }; // tamper, keep old hash
    const result = verifyCustodyChain(chain);
    expect(result).toEqual({ valid: false, index: 2, reason: 'hash_mismatch' });
  });

  it('re-hashing a tampered event still breaks the chain at the next link', () => {
    const chain = buildChain(5);
    const tampered: CustodyEventInput = { ...chain[2]!, payload: { seq: 99 } };
    chain[2] = { ...tampered, prevEventHash: chain[2]!.prevEventHash, hash: custodyEventHash(tampered, chain[2]!.prevEventHash) };
    const result = verifyCustodyChain(chain);
    expect(result).toEqual({ valid: false, index: 3, reason: 'broken_link' });
  });

  it('rejects a first event that claims a predecessor', () => {
    const chain = buildChain(3);
    const result = verifyCustodyChain(chain.slice(1));
    expect(result).toEqual({ valid: false, index: 0, reason: 'dangling_first_link' });
  });
});
