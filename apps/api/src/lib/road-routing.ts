// Road routing behind the pricing engine (ADR-031). Three layers:
//
//   1. `OsrmClient` — a thin HTTP client for a self-hosted OSRM (`/table` for
//      distance matrices, `/route` for polylines). Never exposed publicly;
//      never a hard dependency (OSRM_URL unset = feature off).
//   2. `RoadRouting.resolveMatrix/resolvePair` — the MONEY path. Cache-first
//      against `road_distances`, router only on miss, and **first-write-wins**:
//      whatever lands in the table first is the pair's value forever, so two
//      machines (and two moments) always freeze the same msat. A pair missing
//      from the returned map is "unresolvable right now" — the caller applies
//      the ADR-031 availability policy (omit the card / 503 / fall back where
//      the number is advisory), NEVER a silent metric switch.
//   3. `RoadRouting.geometry` — the DISPLAY path. Separate `route_geometries`
//      cache, straight-chord fallback on any failure: a missing line changes
//      a map, never a price, so this path is allowed to degrade.
//
// The sync/async boundary: the pricing engine (@mercurio/core) is pure and
// synchronous by design. Routes pre-resolve every pair they will need, build
// an in-memory `DistanceProvider` with `providerFromPairMap`, and only then
// call the engine — packages/core does not change for ADR-031.

import { inArray } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { roadDistances, routeGeometries } from '@mercurio/db';
import type { DistanceProvider } from '@mercurio/core';
import { UnresolvedDistanceError } from '@mercurio/core';
import type { GeoPoint } from '@mercurio/shared';

// ---------------------------------------------------------------------------
// Pair keys

/** 1e-4 degrees ≈ 11 m: the pair-key quantum. Coarser than the engine's own
 *  metre quantum on purpose — hub coordinates are fixed and trip origins do
 *  not meaningfully change within 11 m, while a finer key would fragment the
 *  cache for nothing. */
const PAIR_QUANT = 10_000;

const quantE4 = (v: number): number => Math.round(v * PAIR_QUANT);

/** Directed pair key (roads are not symmetric). Every reader and writer of
 *  road_distances/route_geometries MUST build keys through this function. */
export function pairKeyOf(a: GeoPoint, b: GeoPoint): string {
  return `${quantE4(a.lat)}:${quantE4(a.lng)}:${quantE4(b.lat)}:${quantE4(b.lng)}`;
}

/** Key of a single point at pair-key resolution (deduping matrix inputs). */
export function pointKeyOf(p: GeoPoint): string {
  return `${quantE4(p.lat)}:${quantE4(p.lng)}`;
}

const samePoint = (a: GeoPoint, b: GeoPoint): boolean =>
  quantE4(a.lat) === quantE4(b.lat) && quantE4(a.lng) === quantE4(b.lng);

/** pairKey → whole metres. */
export type PairMap = Map<string, number>;

/** Is d(a,b) answerable from `map`? (Identical quantized points are always
 *  answerable: zero metres, no cache row needed.) */
export function hasPair(map: PairMap, a: GeoPoint, b: GeoPoint): boolean {
  return samePoint(a, b) || map.has(pairKeyOf(a, b));
}

/**
 * A synchronous DistanceProvider over pre-resolved pairs. Throwing on a miss
 * is deliberate: the engine must never silently fall back to another metric
 * (ADR-031). The typed error lets the matching engine tell "this drop hub is
 * unavailable this refresh" (it skips the hub) apart from a plain bug — for
 * S/T lookups outside that loop the throw still propagates, as it must.
 */
export function providerFromPairMap(map: PairMap): DistanceProvider {
  return {
    distanceKm(a, b) {
      if (samePoint(a, b)) return 0;
      const metres = map.get(pairKeyOf(a, b));
      if (metres === undefined) {
        throw new UnresolvedDistanceError(`unresolved road pair ${pairKeyOf(a, b)}`);
      }
      return metres / 1000;
    },
  };
}

// ---------------------------------------------------------------------------
// OSRM client

export interface OsrmTable {
  /** metres[si][di]; null where OSRM found no route. */
  metres: (number | null)[][];
  dataVersion: string | null;
}

export interface OsrmRoute {
  metres: number;
  /** [lat, lng] tuples (converted from OSRM's lng,lat GeoJSON). */
  points: [number, number][];
  dataVersion: string | null;
}

export interface OsrmClient {
  table(sources: GeoPoint[], destinations: GeoPoint[]): Promise<OsrmTable>;
  /** null = OSRM answered but found no route (unroutable pair). */
  route(from: GeoPoint, to: GeoPoint): Promise<OsrmRoute | null>;
}

/** Budget per router call: the board must stay snappy, and every value is
 *  cached forever after the first success. */
const OSRM_TIMEOUT_MS = 2500;

// OSRM coordinates travel as lng,lat — the one place the order flips.
const coordsPath = (points: GeoPoint[]): string =>
  points.map((p) => `${p.lng},${p.lat}`).join(';');

export function createOsrmClient(
  baseUrl: string,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): OsrmClient {
  const timeoutMs = opts.timeoutMs ?? OSRM_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = baseUrl.replace(/\/+$/, '');

  const getJson = async (path: string): Promise<Record<string, unknown>> => {
    const res = await fetchImpl(`${base}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    // OSRM reports NoRoute-class outcomes as 400 with a JSON code, so the
    // body is worth parsing even on non-2xx.
    return (await res.json()) as Record<string, unknown>;
  };

  return {
    async table(sources, destinations) {
      const all = [...sources, ...destinations];
      const srcIdx = sources.map((_, i) => i).join(';');
      const dstIdx = destinations.map((_, i) => i + sources.length).join(';');
      const body = await getJson(
        `/table/v1/driving/${coordsPath(all)}?sources=${srcIdx}&destinations=${dstIdx}&annotations=distance`,
      );
      if (body.code !== 'Ok' || !Array.isArray(body.distances)) {
        throw new Error(`osrm table failed: ${String(body.code ?? 'no response code')}`);
      }
      return {
        metres: (body.distances as (number | null)[][]).map((row) =>
          row.map((v) => (typeof v === 'number' ? Math.round(v) : null)),
        ),
        dataVersion: typeof body.data_version === 'string' ? body.data_version : null,
      };
    },

    async route(from, to) {
      const body = await getJson(
        `/route/v1/driving/${coordsPath([from, to])}?overview=simplified&geometries=geojson`,
      );
      if (body.code === 'NoRoute' || body.code === 'NoSegment') return null;
      const route = Array.isArray(body.routes) ? (body.routes[0] as Record<string, unknown>) : null;
      const geometry = route?.geometry as { coordinates?: [number, number][] } | undefined;
      if (body.code !== 'Ok' || !route || !Array.isArray(geometry?.coordinates)) {
        throw new Error(`osrm route failed: ${String(body.code ?? 'no response code')}`);
      }
      return {
        metres: Math.round(route.distance as number),
        points: geometry.coordinates.map(([lng, lat]) => [lat, lng] as [number, number]),
        dataVersion: typeof body.data_version === 'string' ? body.data_version : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The service

export interface GeometrySegment {
  source: 'road' | 'straight';
  points: [number, number][];
}

export interface ResolveOptions {
  /** Never call the router — cache rows only. For reads inside a money
   *  transaction (e.g. rate observations): a transition must not block on
   *  HTTP, and best-effort numbers fall back to haversine instead. */
  cacheOnly?: boolean;
}

export interface RoadRouting {
  /** True when OSRM_URL is configured. Gates the CHOICE of the road metric at
   *  shipment creation — cache reads work even when disabled, because road
   *  shipments in flight must keep pricing deterministically after a deploy
   *  drops the router. */
  readonly enabled: boolean;
  /** MONEY path: metres for every routable (source, destination) combo,
   *  cache-first, first-write-wins. Missing entry = unresolvable right now. */
  resolveMatrix(
    db: Db,
    sources: GeoPoint[],
    destinations: GeoPoint[],
    opts?: ResolveOptions,
  ): Promise<PairMap>;
  /** Single money pair; null = unresolvable right now. */
  resolvePair(db: Db, from: GeoPoint, to: GeoPoint, opts?: ResolveOptions): Promise<number | null>;
  /** DISPLAY path: the road polyline for a hop, straight chord on any miss. */
  geometry(db: Db, from: GeoPoint, to: GeoPoint): Promise<GeometrySegment>;
}

const IN_CHUNK = 400; // keep `pair_key IN (...)` lists bounded

async function readPairs(db: Db, keys: string[]): Promise<PairMap> {
  const map: PairMap = new Map();
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const rows = await db
      .select({ pairKey: roadDistances.pairKey, metres: roadDistances.metres })
      .from(roadDistances)
      .where(inArray(roadDistances.pairKey, chunk));
    for (const r of rows) map.set(r.pairKey, r.metres);
  }
  return map;
}

export function createRoadRouting(options: { client?: OsrmClient; logError?: (err: unknown, what: string) => void }): RoadRouting {
  const client = options.client ?? null;
  const logError = options.logError ?? (() => {});

  const resolveMatrix = async (
    db: Db,
    sources: GeoPoint[],
    destinations: GeoPoint[],
    opts: ResolveOptions = {},
  ): Promise<PairMap> => {
    // Distinct pair keys of the requested matrix (identical quantized points
    // resolve to 0 in the provider and never touch the cache).
    const wanted = new Set<string>();
    for (const s of sources) {
      for (const d of destinations) {
        if (!samePoint(s, d)) wanted.add(pairKeyOf(s, d));
      }
    }
    const keys = [...wanted];
    const map = await readPairs(db, keys);
    const missing = keys.filter((k) => !map.has(k));
    if (missing.length === 0 || !client || opts.cacheOnly) return map;

    try {
      const table = await client.table(sources, destinations);
      const values: { pairKey: string; metres: number; dataVersion: string | null }[] = [];
      const seen = new Set<string>();
      sources.forEach((s, si) => {
        destinations.forEach((d, di) => {
          const metres = table.metres[si]?.[di];
          if (metres === null || metres === undefined || samePoint(s, d)) return;
          const key = pairKeyOf(s, d);
          if (seen.has(key)) return; // duplicate points in the request
          seen.add(key);
          values.push({ pairKey: key, metres, dataVersion: table.dataVersion });
        });
      });
      if (values.length > 0) {
        for (let i = 0; i < values.length; i += IN_CHUNK) {
          // First-write-wins: a concurrent resolver (or an older map version)
          // that got there first keeps the pair — we re-read below.
          await db
            .insert(roadDistances)
            .values(values.slice(i, i + IN_CHUNK))
            .onConflictDoNothing();
        }
      }
      const reread = await readPairs(db, missing);
      for (const [k, v] of reread) map.set(k, v);
    } catch (err) {
      // Router down/overloaded: return what the cache had. The caller applies
      // the ADR-031 availability policy for the rest.
      logError(err, 'osrm table');
    }
    return map;
  };

  return {
    enabled: client !== null,
    resolveMatrix,

    async resolvePair(db, from, to, opts = {}) {
      if (samePoint(from, to)) return 0;
      const map = await resolveMatrix(db, [from], [to], opts);
      return map.get(pairKeyOf(from, to)) ?? null;
    },

    async geometry(db, from, to) {
      const straight: GeometrySegment = {
        source: 'straight',
        points: [
          [from.lat, from.lng],
          [to.lat, to.lng],
        ],
      };
      if (samePoint(from, to)) return straight;
      const key = pairKeyOf(from, to);
      try {
        const [cached] = await db
          .select({ points: routeGeometries.points })
          .from(routeGeometries)
          .where(inArray(routeGeometries.pairKey, [key]));
        if (cached) return { source: 'road', points: cached.points };
        if (!client) return straight;
        const route = await client.route(from, to);
        if (!route) return straight; // unroutable: the chord is the honest line
        await db
          .insert(routeGeometries)
          .values({ pairKey: key, points: route.points, dataVersion: route.dataVersion })
          .onConflictDoNothing();
        return { source: 'road', points: route.points };
      } catch (err) {
        logError(err, 'osrm route');
        return straight;
      }
    },
  };
}

/** Production wiring: OSRM_URL set = road metric available for NEW shipments;
 *  unset = everything behaves exactly as before ADR-031 (cache reads only,
 *  for road shipments already in flight). */
export function createRoadRoutingFromEnv(logError?: (err: unknown, what: string) => void): RoadRouting {
  const url = process.env.OSRM_URL;
  return createRoadRouting({
    ...(url && { client: createOsrmClient(url) }),
    ...(logError && { logError }),
  });
}
