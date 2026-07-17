// GET /me/shipments and GET /me/trips (ADR-018 §5): the account replaces the
// web UI's old `localStorage` memory of ids created on this device. Both
// endpoints must be scoped to the caller (never another user's rows) and
// paginate newest-declaration-first with simple limit/offset.

import { describe, expect, it } from 'vitest';
import { CODENAME_PATTERN } from '@mercurio/shared';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  OFFER_MSAT,
} from './test-world.js';

describe('GET /me/shipments', () => {
  it("returns the sender's own shipments, newest first, with hub names", async () => {
    const world = await createLifecycleWorld();

    // marco's first shipment: checked in, so it reaches AT_HUB.
    const first = await createShipmentAtHub(world);

    // marco's second shipment: auto-accepted but not checked in yet.
    const secondRes = await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubC },
      expect: 201,
    });
    const second = secondRes.json() as { id: string };

    // luca is a sender here too, to prove the list is scoped to the caller.
    await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.luca.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
      expect: 201,
    });

    const res = await world.api({
      method: 'GET',
      url: '/me/shipments',
      cookie: world.marco.cookie,
      expect: 200,
    });
    const body = res.json() as {
      items: {
        id: string;
        status: string;
        originHubId: string;
        originHubName: string;
        destHubId: string;
        destHubName: string;
        offerMsat: string;
        createdAt: string;
      }[];
      total: number;
      limit: number;
      offset: number;
    };

    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id)).toEqual([second.id, first.id]); // newest first
    expect(body.items[0]!.status).toBe('AWAITING_DROPOFF');
    expect(body.items[0]!.destHubName).toBe('Hub C');
    expect(body.items[0]!.offerMsat).toBe(OFFER_MSAT.toString());
    expect(body.items[1]!.status).toBe('AT_HUB');
    expect(body.items[1]!.originHubName).toBe('Hub A');
    expect(body.items[1]!.destHubName).toBe('Hub B');
  });

  it('paginates with limit/offset while total stays the full count', async () => {
    const world = await createLifecycleWorld();
    const first = await createShipmentAtHub(world);
    const secondRes = await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubC },
      expect: 201,
    });
    const second = secondRes.json() as { id: string };

    const page1 = await world.api({
      method: 'GET',
      url: '/me/shipments?limit=1&offset=0',
      cookie: world.marco.cookie,
      expect: 200,
    });
    const body1 = page1.json() as {
      items: { id: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body1.items.map((i) => i.id)).toEqual([second.id]);
    expect(body1.total).toBe(2);
    expect(body1.limit).toBe(1);
    expect(body1.offset).toBe(0);

    const page2 = await world.api({
      method: 'GET',
      url: '/me/shipments?limit=1&offset=1',
      cookie: world.marco.cookie,
      expect: 200,
    });
    const body2 = page2.json() as { items: { id: string }[]; total: number };
    expect(body2.items.map((i) => i.id)).toEqual([first.id]);
    expect(body2.total).toBe(2);
  });

  it('mints a well-formed, unique codename per shipment and echoes it on create + list', async () => {
    const world = await createLifecycleWorld();

    const bodies = await Promise.all(
      [world.hubB, world.hubC].map(async (destHubId) => {
        const res = await world.api({
          method: 'POST',
          url: '/shipments',
          cookie: world.marco.cookie,
          body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId },
          expect: 201,
        });
        return res.json() as { id: string; codename: string };
      }),
    );

    for (const b of bodies) {
      expect(b.codename).toMatch(CODENAME_PATTERN);
    }
    // Distinct shipments get distinct codenames (unique index + mint probe).
    expect(bodies[0]!.codename).not.toBe(bodies[1]!.codename);

    // The same codename the creation returned is the one the list serves.
    const list = await world.api({
      method: 'GET',
      url: '/me/shipments',
      cookie: world.marco.cookie,
      expect: 200,
    });
    const items = (list.json() as { items: { id: string; codename: string }[] }).items;
    for (const b of bodies) {
      expect(items.find((i) => i.id === b.id)?.codename).toBe(b.codename);
    }
  });

  it('requires authentication', async () => {
    const world = await createLifecycleWorld();
    await world.api({ method: 'GET', url: '/me/shipments', expect: 401 });
  });
});

describe('GET /me/trips', () => {
  it("returns the caller's own declared trips, newest first, scoped by caller", async () => {
    const world = await createLifecycleWorld();
    const tripA = await declareTrip(world, world.luca, -5, 50);
    const tripB = await declareTrip(world, world.luca, 10, 90);
    // anna declares one too, to prove the list is scoped to the caller.
    await declareTrip(world, world.anna, 0, 100);

    const res = await world.api({
      method: 'GET',
      url: '/me/trips',
      cookie: world.luca.cookie,
      expect: 200,
    });
    const body = res.json() as {
      items: {
        id: string;
        status: string;
        originLng: number;
        destLng: number;
        minRateMsatPerKm: string;
        expiresAt: string;
      }[];
      total: number;
      limit: number;
      offset: number;
    };

    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.id)).toEqual([tripB, tripA]); // newest first
    expect(body.items[0]!.status).toBe('active');
    expect(body.items[0]!.minRateMsatPerKm).toBe('20000');
    expect(body.items[0]!.originLng).toBe(10);
    expect(body.items[0]!.destLng).toBe(90);
  });

  it('requires authentication', async () => {
    const world = await createLifecycleWorld();
    await world.api({ method: 'GET', url: '/me/trips', expect: 401 });
  });
});
