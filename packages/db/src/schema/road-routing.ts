import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// ADR-031 — road routing in pricing. Two caches with opposite contracts:
//
// `road_distances` is MONEY: the deterministic source of truth for every
// road-metric distance the pricing engine consumes. Append-only and
// first-write-wins — once a pair is written it NEVER changes, not even after
// a map update (updates only ever improve pairs never seen before). That is
// what keeps frozen prices recomputable from the DB alone (ECONOMICS §6:
// "two machines freeze the same msat") without archiving OSRM snapshots.
//
// `route_geometries` is DISPLAY: polylines for the trip map. Same key shape
// for convenience, but rows here are droppable/refreshable at will — a
// redrawn road changes a line on a map, never a price.
//
// pair_key = "fromLatE4:fromLngE4:toLatE4:toLngE4" — WGS84 degrees quantized
// to 1e-4 (~11 m), DIRECTED (roads are not symmetric). The quantizer lives in
// apps/api/src/lib/road-routing.ts; every reader and writer must go through
// it or keys will not line up.

export const roadDistances = pgTable('road_distances', {
  pairKey: text('pair_key').primaryKey(),
  /** Road distance in whole metres — the engine's own quantum (ECONOMICS §6). */
  metres: integer('metres').notNull(),
  source: text('source').notNull().default('osrm'),
  /** OSRM's data_version when the response carried one (diagnostics only —
   *  the first-write-wins rule is what guarantees determinism, not this). */
  dataVersion: text('data_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const routeGeometries = pgTable('route_geometries', {
  pairKey: text('pair_key').primaryKey(),
  /** [lat, lng] tuples of the road shape (OSRM geometry, lat/lng order). */
  points: jsonb('points').$type<[number, number][]>().notNull(),
  source: text('source').notNull().default('osrm'),
  dataVersion: text('data_version'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
