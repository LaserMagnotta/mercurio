// Unit tests for the ADR-031 road-routing layer. The money-critical property
// is FIRST-WRITE-WINS: once a pair lands in road_distances it never changes,
// whatever the router answers later — that is what makes road-metric prices
// deterministic and recomputable from the DB alone.

import { describe, expect, it } from 'vitest';
import { createTestDb } from '@mercurio/db/test-helpers';
import { roadDistances } from '@mercurio/db';
import type { GeoPoint } from '@mercurio/shared';
import {
  createOsrmClient,
  createRoadRouting,
  hasPair,
  pairKeyOf,
  pointKeyOf,
  providerFromPairMap,
  type OsrmClient,
} from './road-routing.js';

const A: GeoPoint = { lat: 44.5, lng: 11.3 }; // Bologna-ish
const B: GeoPoint = { lat: 43.77, lng: 11.25 }; // Firenze-ish
const C: GeoPoint = { lat: 44.8, lng: 10.33 }; // Parma-ish

/** Deterministic fake router: metres = a recognizable linear formula, so a
 *  changed formula in a second client simulates a map update. */
function fakeClient(factor: number, log?: string[]): OsrmClient {
  const metres = (a: GeoPoint, b: GeoPoint) =>
    Math.round((Math.abs(a.lat - b.lat) + Math.abs(a.lng - b.lng)) * factor);
  return {
    async table(sources, destinations) {
      log?.push('table');
      return {
        metres: sources.map((s) => destinations.map((d) => metres(s, d))),
        dataVersion: `fake-${factor}`,
      };
    },
    async route(from, to) {
      log?.push('route');
      return {
        metres: metres(from, to),
        points: [
          [from.lat, from.lng],
          [(from.lat + to.lat) / 2, (from.lng + to.lng) / 2 + 0.1], // a bend
          [to.lat, to.lng],
        ],
        dataVersion: `fake-${factor}`,
      };
    },
  };
}

describe('pair keys', () => {
  it('quantizes to 1e-4 degrees and stays directed', () => {
    expect(pairKeyOf(A, B)).toBe('445000:113000:437700:112500');
    expect(pairKeyOf(B, A)).not.toBe(pairKeyOf(A, B));
    // Within the 11 m quantum the key is stable...
    expect(pairKeyOf({ lat: 44.50004, lng: 11.3 }, B)).toBe(pairKeyOf(A, B));
    // ...beyond it, it is not.
    expect(pairKeyOf({ lat: 44.5001, lng: 11.3 }, B)).not.toBe(pairKeyOf(A, B));
    expect(pointKeyOf(A)).toBe('445000:113000');
  });
});

describe('providerFromPairMap', () => {
  it('returns km, zero for identical points, and throws on unresolved pairs', () => {
    const provider = providerFromPairMap(new Map([[pairKeyOf(A, B), 123_456]]));
    expect(provider.distanceKm(A, B)).toBeCloseTo(123.456, 9);
    expect(provider.distanceKm(A, { lat: A.lat, lng: A.lng })).toBe(0);
    expect(() => provider.distanceKm(B, A)).toThrow(/unresolved road pair/);
  });
});

describe('resolveMatrix', () => {
  it('fetches misses from the router, persists them, and serves them back', async () => {
    const db = await createTestDb();
    const log: string[] = [];
    const routing = createRoadRouting({ client: fakeClient(100_000, log) });

    const map = await routing.resolveMatrix(db, [A], [B, C]);
    expect(map.get(pairKeyOf(A, B))).toBe(Math.round((0.73 + 0.05) * 100_000));
    expect(hasPair(map, A, C)).toBe(true);
    expect(log).toEqual(['table']);

    // Second resolve: pure cache, no router call.
    const again = await routing.resolveMatrix(db, [A], [B, C]);
    expect(again.get(pairKeyOf(A, B))).toBe(map.get(pairKeyOf(A, B)));
    expect(log).toEqual(['table']);
  });

  it('first write wins: a later router (map update) never changes a pair', async () => {
    const db = await createTestDb();
    const v1 = createRoadRouting({ client: fakeClient(100_000) });
    const first = await v1.resolveMatrix(db, [A], [B]);

    const v2 = createRoadRouting({ client: fakeClient(999_999) });
    // Ask for a superset: the cached pair must survive, only the new pair
    // may come from the new router.
    const second = await v2.resolveMatrix(db, [A], [B, C]);
    expect(second.get(pairKeyOf(A, B))).toBe(first.get(pairKeyOf(A, B)));
    expect(second.get(pairKeyOf(A, C))).toBe(
      Math.round((Math.abs(A.lat - C.lat) + Math.abs(A.lng - C.lng)) * 999_999),
    );
  });

  it('keeps serving the cache when the router is down, and omits cold pairs', async () => {
    const db = await createTestDb();
    const warm = createRoadRouting({ client: fakeClient(100_000) });
    await warm.resolveMatrix(db, [A], [B]);

    const down = createRoadRouting({
      client: {
        table: async () => {
          throw new Error('ECONNREFUSED');
        },
        route: async () => {
          throw new Error('ECONNREFUSED');
        },
      },
    });
    const map = await down.resolveMatrix(db, [A], [B, C]);
    expect(hasPair(map, A, B)).toBe(true); // warm pair still there
    expect(hasPair(map, A, C)).toBe(false); // cold pair honestly missing
  });

  it('cacheOnly never touches the router', async () => {
    const db = await createTestDb();
    const log: string[] = [];
    const routing = createRoadRouting({ client: fakeClient(100_000, log) });
    const map = await routing.resolveMatrix(db, [A], [B], { cacheOnly: true });
    expect(hasPair(map, A, B)).toBe(false);
    expect(log).toEqual([]);
  });

  it('skips unroutable combos without failing the rest', async () => {
    const db = await createTestDb();
    const routing = createRoadRouting({
      client: {
        async table(sources, destinations) {
          return {
            metres: sources.map(() => destinations.map((_, di) => (di === 0 ? null : 42_000))),
            dataVersion: null,
          };
        },
        route: async () => null,
      },
    });
    const map = await routing.resolveMatrix(db, [A], [B, C]);
    expect(hasPair(map, A, B)).toBe(false); // unroutable
    expect(map.get(pairKeyOf(A, C))).toBe(42_000);
  });

  it('resolvePair answers zero for identical points without a router', async () => {
    const db = await createTestDb();
    const routing = createRoadRouting({});
    expect(await routing.resolvePair(db, A, { lat: A.lat, lng: A.lng })).toBe(0);
    expect(await routing.resolvePair(db, A, B)).toBeNull(); // disabled + cold
  });

  it('reads a hand-seeded row even with no client (router removed later)', async () => {
    const db = await createTestDb();
    await db.insert(roadDistances).values({ pairKey: pairKeyOf(A, B), metres: 77_000 });
    const routing = createRoadRouting({});
    expect(routing.enabled).toBe(false);
    expect(await routing.resolvePair(db, A, B)).toBe(77_000);
  });
});

describe('geometry', () => {
  it('caches the road shape and falls back to the straight chord', async () => {
    const db = await createTestDb();
    const log: string[] = [];
    const routing = createRoadRouting({ client: fakeClient(100_000, log) });

    const road = await routing.geometry(db, A, B);
    expect(road.source).toBe('road');
    expect(road.points).toHaveLength(3);
    expect(log).toEqual(['route']);

    // Cached: same shape, no second router call.
    const cached = await routing.geometry(db, A, B);
    expect(cached).toEqual({ source: 'road', points: road.points });
    expect(log).toEqual(['route']);

    // Router down, cold pair: the chord — a line on a map, never an error.
    const down = createRoadRouting({
      client: {
        table: async () => {
          throw new Error('down');
        },
        route: async () => {
          throw new Error('down');
        },
      },
    });
    const chord = await down.geometry(db, B, C);
    expect(chord).toEqual({
      source: 'straight',
      points: [
        [B.lat, B.lng],
        [C.lat, C.lng],
      ],
    });
  });
});

describe('createOsrmClient', () => {
  it('speaks OSRM: lng,lat coordinates, distance annotations, geojson flip', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: unknown) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/table/')) {
        return {
          json: async () => ({
            code: 'Ok',
            distances: [[1234.6, null]],
            data_version: '2026-07-01',
          }),
        };
      }
      return {
        json: async () => ({
          code: 'Ok',
          routes: [
            {
              distance: 9876.4,
              geometry: {
                coordinates: [
                  [11.3, 44.5],
                  [11.25, 43.77],
                ],
              },
            },
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const client = createOsrmClient('http://osrm.test', { fetchImpl });
    const table = await client.table([A], [B, C]);
    expect(table.metres).toEqual([[1235, null]]);
    expect(table.dataVersion).toBe('2026-07-01');
    // lng,lat on the wire; sources/destinations as index lists.
    expect(calls[0]).toContain('/table/v1/driving/11.3,44.5;11.25,43.77;10.33,44.8');
    expect(calls[0]).toContain('sources=0');
    expect(calls[0]).toContain('destinations=1;2');
    expect(calls[0]).toContain('annotations=distance');

    const route = await client.route(A, B);
    expect(route).toEqual({
      metres: 9876,
      points: [
        [44.5, 11.3],
        [43.77, 11.25],
      ],
      dataVersion: null,
    });
  });

  it('maps NoRoute to null and other errors to throws', async () => {
    const noRoute = createOsrmClient('http://osrm.test', {
      fetchImpl: (async () => ({ json: async () => ({ code: 'NoRoute' }) })) as unknown as typeof fetch,
    });
    expect(await noRoute.route(A, B)).toBeNull();

    const broken = createOsrmClient('http://osrm.test', {
      fetchImpl: (async () => ({ json: async () => ({ code: 'InvalidQuery' }) })) as unknown as typeof fetch,
    });
    await expect(broken.table([A], [B])).rejects.toThrow(/osrm table failed/);
    await expect(broken.route(A, B)).rejects.toThrow(/osrm route failed/);
  });
});
