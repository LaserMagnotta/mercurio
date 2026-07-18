// ADR-030 end-to-end: hub discovery at scale (bbox + text search + distance
// sort + pagination, never the full table) and the per-hub waiting-shipments
// view (reverse trip planning) over the real HTTP surface.

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { hubs, legs } from '@mercurio/db';
import {
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  type LifecycleWorld,
} from './test-world.js';

interface HubEntry {
  id: string;
  name: string;
  distanceKm?: number;
}

async function listHubs(
  world: LifecycleWorld,
  query: string,
): Promise<{ hubs: HubEntry[]; total: number }> {
  const res = await world.api({ method: 'GET', url: `/hubs${query}`, expect: 200 });
  return res.json() as { hubs: HubEntry[]; total: number };
}

describe('hub discovery (ADR-030)', () => {
  it('no params: legacy full list; bbox, q and pagination bound the page but total counts all', async () => {
    const world = await createLifecycleWorld();

    const legacy = await listHubs(world, '');
    expect(legacy.hubs).toHaveLength(3);
    expect(legacy.total).toBe(3);

    // bbox around A (lng 0) and C (lng 40) excludes B (lng 100).
    const boxed = await listHubs(world, '?bbox=-1,-1,1,50');
    expect(boxed.hubs.map((h) => h.name).sort()).toEqual(['Hub A', 'Hub C']);
    expect(boxed.total).toBe(2);

    // Text search hits name AND address, case-insensitively.
    const byName = await listHubs(world, '?q=hub%20b');
    expect(byName.hubs.map((h) => h.name)).toEqual(['Hub B']);
    const byAddress = await listHubs(world, '?q=via%20c');
    expect(byAddress.hubs.map((h) => h.name)).toEqual(['Hub C']);
    // LIKE wildcards in user text are literals, not scans.
    expect((await listHubs(world, '?q=%25')).hubs).toEqual([]);

    // Pagination: page bounded, total untouched.
    const page = await listHubs(world, '?limit=2&offset=2');
    expect(page.hubs).toHaveLength(1);
    expect(page.total).toBe(3);
  }, 30_000);

  it('near sorts by distance and fills distanceKm; /hubs/:id returns the same shape', async () => {
    const world = await createLifecycleWorld();
    // From lng 95 the order is B (100), C (40), A (0).
    const sorted = await listHubs(world, '?near=0,95');
    expect(sorted.hubs.map((h) => h.name)).toEqual(['Hub B', 'Hub C', 'Hub A']);
    expect(sorted.hubs[0]!.distanceKm).toBeCloseTo(5, 5);
    expect(sorted.hubs[2]!.distanceKm).toBeCloseTo(95, 5);

    const detail = await world.api({ method: 'GET', url: `/hubs/${world.hubC}`, expect: 200 });
    expect((detail.json() as { name: string }).name).toBe('Hub C');
    await world.api({ method: 'GET', url: `/hubs/${world.marco.id}`, expect: 404 });
  }, 30_000);

  it('waiting-shipments: the idle parcel is listed with its indicative ceiling, then leaves with a request', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);

    // Session required: the shelf inventory is not for the open web.
    await world.api({ method: 'GET', url: `/hubs/${world.hubA}/waiting-shipments`, expect: 401 });

    const res = await world.api({
      method: 'GET',
      url: `/hubs/${world.hubA}/waiting-shipments`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    const body = res.json() as {
      shipments: { shipmentId: string; destHubName: string; remainingKm: number; maxGrossMsat: string }[];
    };
    expect(body.shipments).toHaveLength(1);
    expect(body.shipments[0]!.shipmentId).toBe(id);
    expect(body.shipments[0]!.destHubName).toBe('Hub B');
    expect(body.shipments[0]!.remainingKm).toBeCloseTo(100, 5);
    // Ceiling = whole work pool (7 200 000) + accrued carrier bonus (560 000).
    expect(body.shipments[0]!.maxGrossMsat).toBe('7760000');

    // Another hub has nothing waiting.
    const elsewhere = await world.api({
      method: 'GET',
      url: `/hubs/${world.hubC}/waiting-shipments`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    expect((elsewhere.json() as { shipments: unknown[] }).shipments).toEqual([]);

    // A pending deposit request takes it off the shelf (ADR-029 exclusivity).
    await world.db.update(hubs).set({ autoAccept: false }).where(eq(hubs.id, world.hubC));
    const trip = await declareTrip(world, world.luca, -5, 45);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId: trip, toHubId: world.hubC },
      expect: 201,
    });
    const [legRow] = await world.db.select().from(legs);
    expect(legRow!.status).toBe('requested');
    const afterRequest = await world.api({
      method: 'GET',
      url: `/hubs/${world.hubA}/waiting-shipments`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    expect((afterRequest.json() as { shipments: unknown[] }).shipments).toEqual([]);
  }, 30_000);
});
