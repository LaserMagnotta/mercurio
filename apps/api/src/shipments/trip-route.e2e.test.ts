// Trip route view (ADR-015, data part), end to end over HTTP on pglite.
//
// The flat test-world geography makes every expectation readable: hubs A, C,
// B sit at lng 0, 40, 100 on the same parallel, Luca's trip runs lng −5 → 50,
// so the computed visit order and the Google Maps deep link are exact.

import { describe, expect, it } from 'vitest';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  sha,
  type LifecycleWorld,
} from './test-world';
import { pumpWalletEvents } from './pump';

interface RouteStopDto {
  hubId: string;
  hubName: string;
  lat: number;
  lng: number;
  kind: 'pickup' | 'drop';
  shipmentId: string;
  legId: string | null;
  preview: boolean;
}

interface TripRouteDto {
  tripId: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  stops: RouteStopDto[];
  unroutedStops: RouteStopDto[];
  googleMapsUrl: string;
}

async function getRoute(
  world: LifecycleWorld,
  tripId: string,
  query = '',
  expectStatus = 200,
): Promise<TripRouteDto> {
  const res = await world.api({
    method: 'GET',
    url: `/trips/${tripId}/route${query}`,
    cookie: world.luca.cookie,
    expect: expectStatus,
  });
  return res.json() as TripRouteDto;
}

/** A second shipment C→B, checked in at hub C and ready for a leg. */
async function createShipmentAtC(world: LifecycleWorld): Promise<string> {
  const created = await world.api({
    method: 'POST',
    url: '/shipments',
    cookie: world.marco.cookie,
    body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubC, destHubId: world.hubB },
    expect: 201,
  });
  const { id, qrToken } = created.json() as { id: string; qrToken: string };
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/origin-checkin`,
    cookie: world.carla.cookie,
    body: { qrToken, photoSha256: [sha('drop-off-c')] },
    expect: 200,
  });
  return id;
}

describe('trip route view (ADR-015)', () => {
  it('previews a board shipment before any leg exists', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);

    const route = await getRoute(
      world,
      tripId,
      `?previewShipmentId=${id}&previewDropHubId=${world.hubC}`,
    );
    expect(route.origin).toEqual({ lat: 0, lng: -5 });
    expect(route.destination).toEqual({ lat: 0, lng: 50 });
    expect(route.unroutedStops).toEqual([]);
    expect(route.stops.map((s) => [s.hubId, s.kind, s.preview, s.legId])).toEqual([
      [world.hubA, 'pickup', true, null],
      [world.hubC, 'drop', true, null],
    ]);
    // ADR-015 URL shape: our visit order, driving mode, nothing implicit.
    expect(route.googleMapsUrl).toBe(
      'https://www.google.com/maps/dir/?api=1' +
        '&origin=0.000000%2C-5.000000&destination=0.000000%2C50.000000' +
        '&travelmode=driving&waypoints=0.000000%2C0.000000%7C0.000000%2C40.000000',
    );
  });

  it('orders the stops of two accepted legs and drops the pickup once picked up', async () => {
    const world = await createLifecycleWorld();
    const { id: shipA, qrToken } = await createShipmentAtHub(world);
    const shipC = await createShipmentAtC(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);

    const legA = await world.api({
      method: 'POST',
      url: `/shipments/${shipA}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubC },
      expect: 201,
    });
    const legAId = (legA.json() as { legId: string }).legId;
    await world.api({
      method: 'POST',
      url: `/shipments/${shipC}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubB },
      expect: 201,
    });

    // Pending-funding legs are accepted legs: both appear, optimally ordered
    // A → C → C → B (the two hub-C stops tie on cost, their mutual order is
    // an implementation detail — assert the set, not the sequence).
    const route = await getRoute(world, tripId);
    expect(route.stops).toHaveLength(4);
    expect(route.stops[0]).toMatchObject({ hubId: world.hubA, kind: 'pickup', legId: legAId });
    expect(new Set(route.stops.slice(1, 3).map((s) => `${s.hubId}:${s.kind}`))).toEqual(
      new Set([`${world.hubC}:drop`, `${world.hubC}:pickup`]),
    );
    expect(route.stops[3]).toMatchObject({ hubId: world.hubB, kind: 'drop' });
    // Consecutive stops at hub C collapse into one Google Maps waypoint.
    expect(route.googleMapsUrl).toContain(
      'waypoints=0.000000%2C0.000000%7C0.000000%2C40.000000%7C0.000000%2C100.000000',
    );

    // Fund and check out shipment A's leg: its pickup disappears (done),
    // only the drop at C remains for that shipment.
    world.clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    await doubleConfirmCheckout(world, shipA, qrToken, world.mario, world.luca);
    const after = await getRoute(world, tripId);
    expect(
      after.stops.filter((s) => s.shipmentId === shipA).map((s) => [s.hubId, s.kind]),
    ).toEqual([[world.hubC, 'drop']]);
  });

  it('routes whole shipments up to MAX_ROUTE_WAYPOINTS and lists the rest unrouted', async () => {
    const world = await createLifecycleWorld();
    const tripId = await declareTrip(world, world.luca, -5, 50);

    // Four accepted legs A→C (8 stops) fill the cap; the preview of a fifth
    // shipment cannot be routed and comes back in unroutedStops.
    for (let i = 0; i < 4; i += 1) {
      const { id } = await createShipmentAtHub(world);
      await world.api({
        method: 'POST',
        url: `/shipments/${id}/legs`,
        cookie: world.luca.cookie,
        body: { tripId, toHubId: world.hubC },
        expect: 201,
      });
    }
    const { id: fifth } = await createShipmentAtHub(world);

    const route = await getRoute(
      world,
      tripId,
      `?previewShipmentId=${fifth}&previewDropHubId=${world.hubC}`,
    );
    expect(route.stops).toHaveLength(8);
    expect(route.stops.every((s) => !s.preview)).toBe(true);
    expect(route.unroutedStops.map((s) => [s.shipmentId, s.kind, s.preview])).toEqual([
      [fifth, 'pickup', true],
      [fifth, 'drop', true],
    ]);
  });

  it('is owner-only and validates the preview pair', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);

    await world.api({
      method: 'GET',
      url: `/trips/${tripId}/route`,
      cookie: world.mario.cookie,
      expect: 404,
    });
    // Preview needs both fields (zod refine) …
    await world.api({
      method: 'GET',
      url: `/trips/${tripId}/route?previewShipmentId=${id}`,
      cookie: world.luca.cookie,
      expect: 400,
    });
    // … and an existing, active drop hub.
    await world.api({
      method: 'GET',
      url: `/trips/${tripId}/route?previewShipmentId=${id}&previewDropHubId=${tripId}`,
      cookie: world.luca.cookie,
      expect: 404,
    });
  });
});
