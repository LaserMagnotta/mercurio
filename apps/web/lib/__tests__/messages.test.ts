// Copy completeness: every shipment state, custody event type and mapped API
// error code must have copy in BOTH catalogs — "en pronto" (CLAUDE.md) means
// the English catalog can never lag silently behind the Italian one.

import { describe, expect, it } from 'vitest';
import { SHIPMENT_STATES } from '@mercurio/shared';
import it_ from '../../messages/it.json';
import en from '../../messages/en.json';
import { CUSTODY_EVENT_TYPES, SENDER_ACTIONS, SHIPMENT_STATUS_TONE } from '../shipment-status';
import { KNOWN_API_ERROR_CODES } from '../api-error-codes';

const catalogs = { it: it_, en } as const;

function keysOf(obj: unknown): Set<string> {
  return new Set(Object.keys((obj ?? {}) as Record<string, unknown>));
}

describe('shipment states', () => {
  it('every state has a tone and an offered-actions entry', () => {
    for (const state of SHIPMENT_STATES) {
      expect(SHIPMENT_STATUS_TONE[state], state).toBeDefined();
      expect(SENDER_ACTIONS[state], state).toBeDefined();
    }
  });

  it.each(Object.entries(catalogs))('catalog %s covers every state', (_name, catalog) => {
    const statuses = catalog.statuses as Record<string, { label?: string; description?: string }>;
    for (const state of SHIPMENT_STATES) {
      expect(statuses[state]?.label, `${state}.label`).toBeTruthy();
      expect(statuses[state]?.description, `${state}.description`).toBeTruthy();
    }
  });
});

describe('custody events', () => {
  it.each(Object.entries(catalogs))('catalog %s covers every event type', (_name, catalog) => {
    const custody = keysOf(catalog.custody);
    for (const type of CUSTODY_EVENT_TYPES) {
      expect(custody.has(type), type).toBe(true);
    }
  });
});

describe('api error codes', () => {
  it.each(Object.entries(catalogs))('catalog %s covers every mapped code', (_name, catalog) => {
    const errors = keysOf(catalog.apiErrors);
    expect(errors.has('fallback')).toBe(true);
    for (const code of KNOWN_API_ERROR_CODES) {
      expect(errors.has(code), code).toBe(true);
    }
  });
});

describe('catalog parity', () => {
  it('it and en expose the same key tree', () => {
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        typeof value === 'object' && value !== null
          ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
          : [`${prefix}${key}`],
      );
    expect(flatten(en as Record<string, unknown>).sort()).toEqual(
      flatten(it_ as Record<string, unknown>).sort(),
    );
  });
});
