// ADR-031 end to end: road distances INSIDE pricing. The properties under
// test are the ones the ADR's design section promises:
//   - the metric freezes per shipment at creation ('road' iff the router
//     answers right then) and never changes;
//   - board and frozen leg prices read the same road_distances rows, so the
//     card's net IS the frozen net (no-surprise contract, MATCHING §7.3);
//   - a dead router blocks nothing: warm pairs keep pricing, cold road cards
//     are omitted, strict money ops (reroute) come back 503-retriable, and
//     haversine shipments never notice;
//   - claims price on the shipment's metric too.
//
// Geography is the flat test world (degrees read as km); the fake OSRM
// answers metres = flat km × 1500, so every "road" figure is exactly 1.5×
// the haversine one — impossible to confuse the two metrics by accident.

import { beforeAll, describe, expect, it } from 'vitest';
import { emailOutbox, hubs, users } from '@mercurio/db';
import { createRoadRouting, type OsrmClient } from '../lib/road-routing.js';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  sha,
  type LifecycleWorld,
} from './test-world.js';

const ROAD_METRES_PER_FLAT_KM = 1500; // road km = flat km × 1.5

interface BoardCard {
  shipmentId: string;
  distanceMetric: string;
  remainingKm: number;
  totalKm: number;
  bestDropHub: { hubId: string; netMsat: string; detourKm: number };
}

describe('road routing in pricing (ADR-031)', () => {
  let world: LifecycleWorld;
  let routerDown = false;

  const fakeOsrm: OsrmClient = {
    async table(sources, destinations) {
      if (routerDown) throw new Error('osrm down');
      return {
        metres: sources.map((s) =>
          destinations.map((d) =>
            Math.round(Math.hypot(s.lat - d.lat, s.lng - d.lng) * ROAD_METRES_PER_FLAT_KM),
          ),
        ),
        dataVersion: 'e2e-fake',
      };
    },
    async route(from, to) {
      if (routerDown) throw new Error('osrm down');
      return {
        metres: Math.round(Math.hypot(from.lat - to.lat, from.lng - to.lng) * ROAD_METRES_PER_FLAT_KM),
        points: [
          [from.lat, from.lng],
          [to.lat, to.lng],
        ],
        dataVersion: 'e2e-fake',
      };
    },
  };

  /** Set by the first test (cold cache, router down): a shipment that is
   *  'haversine' forever, reused later to prove mixed boards. */
  let havId = '';

  beforeAll(async () => {
    world = await createLifecycleWorld({
      roadRouting: createRoadRouting({ client: fakeOsrm }),
    });
  });

  it('with the router down and a cold cache, a shipment is born haversine — forever', async () => {
    routerDown = true;
    try {
      const { id } = await createShipmentAtHub(world);
      havId = id;
    } finally {
      routerDown = false;
    }
    const detail = (await (
      await world.api({
        method: 'GET',
        url: `/shipments/${havId}`,
        cookie: world.marco.cookie,
        expect: 200,
      })
    ).json()) as { distanceMetric: string; distanceKm: number };
    expect(detail.distanceMetric).toBe('haversine');
    expect(detail.distanceKm).toBe(100); // flat A→B, ADR-007 metric of this world
  });

  it('freezes the road metric and the road D at creation', async () => {
    const { id } = await createShipmentAtHub(world);
    const detail = (await (
      await world.api({
        method: 'GET',
        url: `/shipments/${id}`,
        cookie: world.marco.cookie,
        expect: 200,
      })
    ).json()) as { distanceMetric: string; distanceKm: number; remainingKm: number };
    // Flat A→B is 100 km; the road metric froze 150.
    expect(detail.distanceMetric).toBe('road');
    expect(detail.distanceKm).toBe(150);
    // remainingKm at the origin reads the SAME cached pair: exactly D.
    expect(detail.remainingKm).toBe(150);
  });

  it('board and frozen leg price agree, both on road distances', async () => {
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, 0, 100);

    const board = (await (
      await world.api({
        method: 'GET',
        url: `/trips/${tripId}/board`,
        cookie: world.luca.cookie,
        expect: 200,
      })
    ).json()) as { cards: BoardCard[] };
    const card = board.cards.find((c) => c.shipmentId === id)!;
    expect(card).toBeDefined();
    expect(card.distanceMetric).toBe('road');
    expect(card.remainingKm).toBe(150);
    expect(card.totalKm).toBe(150);
    // Direct delivery to B: gross = full work pool (7 200 000), net = ×0.8
    // plus the carrier bonus 560 000 — computed on ROAD r (150 = 150), and
    // the trip riding the same axis has zero detour.
    expect(card.bestDropHub.hubId).toBe(world.hubB);
    expect(card.bestDropHub.netMsat).toBe('6320000');
    expect(card.bestDropHub.detourKm).toBe(0);

    // No surprises: the frozen pricing IS the card's number. (The card's net
    // includes the delivery bonus; the frozen row keeps them as two fields.)
    const leg = (await (
      await world.api({
        method: 'POST',
        url: `/shipments/${id}/legs`,
        cookie: world.luca.cookie,
        body: { tripId, toHubId: world.hubB },
        expect: 201,
      })
    ).json()) as {
      pricing: { netMsat: string; grossMsat: string; finalizationBonusMsat: string };
    };
    expect(leg.pricing.netMsat).toBe('5760000');
    expect(leg.pricing.finalizationBonusMsat).toBe('560000');
    expect(BigInt(leg.pricing.netMsat) + BigInt(leg.pricing.finalizationBonusMsat)).toBe(
      BigInt(card.bestDropHub.netMsat),
    );
    expect(leg.pricing.grossMsat).toBe('7200000');
  });

  it('keeps pricing road shipments from the cache while the router is down, and omits cold ones', async () => {
    const { id: warmId } = await createShipmentAtHub(world);

    routerDown = true;
    try {
      // Router down but the (A, B) pair is WARM: the creation still resolves
      // from the first-write-wins cache and the shipment is born 'road' —
      // deliberate (ADR-031: "resolvable now" means cache OR router).
      const created = await world.api({
        method: 'POST',
        url: '/shipments',
        cookie: world.marco.cookie,
        body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
        expect: 201,
      });
      const { id: warmBornId, qrToken } = (await created.json()) as {
        id: string;
        qrToken: string;
      };
      await world.api({
        method: 'POST',
        url: `/shipments/${warmBornId}/origin-checkin`,
        cookie: world.mario.cookie,
        body: { qrToken, photoSha256: [sha('drop-off')] },
        expect: 200,
      });
      const warmBorn = (await (
        await world.api({
          method: 'GET',
          url: `/shipments/${warmBornId}`,
          cookie: world.marco.cookie,
          expect: 200,
        })
      ).json()) as { distanceMetric: string; distanceKm: number };
      expect(warmBorn.distanceMetric).toBe('road');
      expect(warmBorn.distanceKm).toBe(150);

      // A trip along the SAME warm axis: every road pair it needs is cached,
      // so the road card survives the outage — the determinism the
      // first-write-wins table exists for.
      const warmTrip = await declareTrip(world, world.luca, 0, 100);
      const warmBoard = (await (
        await world.api({
          method: 'GET',
          url: `/trips/${warmTrip}/board`,
          cookie: world.luca.cookie,
          expect: 200,
        })
      ).json()) as { cards: BoardCard[] };
      const warmCard = warmBoard.cards.find((c) => c.shipmentId === warmId);
      expect(warmCard).toBeDefined();
      expect(warmCard!.remainingKm).toBe(150);
      // The haversine shipment rides the same board, on its own metric.
      const havCard = warmBoard.cards.find((c) => c.shipmentId === havId);
      expect(havCard).toBeDefined();
      expect(havCard!.distanceMetric).toBe('haversine');
      expect(havCard!.remainingKm).toBe(100);

      // A trip from a NEVER-SEEN origin needs cold pairs: the road card is
      // omitted this refresh; the haversine one is untouched.
      const coldTrip = await declareTrip(world, world.anna, -50, 100);
      const coldBoard = (await (
        await world.api({
          method: 'GET',
          url: `/trips/${coldTrip}/board`,
          cookie: world.anna.cookie,
          expect: 200,
        })
      ).json()) as { cards: BoardCard[] };
      expect(coldBoard.cards.find((c) => c.shipmentId === warmId)).toBeUndefined();
      expect(coldBoard.cards.find((c) => c.shipmentId === havId)).toBeDefined();
    } finally {
      routerDown = false;
    }
  });

  it('refuses (503, retriable) a road money op that needs a cold pair, then honors the retry', async () => {
    const { id } = await createShipmentAtHub(world);
    // A hub no board has ever seen: its pairs are guaranteed cold. (Earlier
    // boards in this suite warmed every A/B/C combination.) One hub per user
    // (hubs_user_id_unique): it needs its own owner.
    const [hubDOwner] = await world.db
      .insert(users)
      .values({ email: 'hubd@test.local', locale: 'it' })
      .returning();
    const [hubD] = await world.db
      .insert(hubs)
      .values({
        userId: hubDOwner!.id,
        name: 'Hub D',
        address: 'Via D 1',
        lat: 0,
        lng: 70,
        openingHours: [],
        maxDimCmL: 50,
        maxDimCmW: 50,
        maxDimCmH: 50,
        maxWeightG: 15_000,
        acceptsUndeclared: true,
        feePercent: '10.00',
        maxStorageDays: 7,
        autoAccept: true,
        active: true,
      })
      .returning();

    routerDown = true;
    try {
      // Reroute to D needs the never-resolved (A, D) pair: strict refusal,
      // never a silent haversine reprice.
      const refused = await world.api({
        method: 'POST',
        url: `/shipments/${id}/reroute`,
        cookie: world.marco.cookie,
        body: { newDestHubId: hubD!.id },
        expect: 503,
      });
      expect((await refused.json()) as object).toMatchObject({
        error: 'road_routing_unavailable',
      });
    } finally {
      routerDown = false;
    }

    // Router back: the same call resolves (A, D) = 70 flat km, road 105.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/reroute`,
      cookie: world.marco.cookie,
      body: { newDestHubId: hubD!.id },
      expect: 200,
    });
    const detail = (await (
      await world.api({
        method: 'GET',
        url: `/shipments/${id}`,
        cookie: world.marco.cookie,
        expect: 200,
      })
    ).json()) as { distanceMetric: string; distanceKm: number };
    expect(detail.distanceMetric).toBe('road'); // the birth metric survives the reroute
    expect(detail.distanceKm).toBe(105); // new segment D* = road(A → D)
  });

  it('prices a recipient claim on the road metric', async () => {
    const { id } = await createShipmentAtHub(world);
    const trackingRows = (await world.db.select().from(emailOutbox)).filter(
      (r) => r.template === 'parcel_tracking',
    );
    const claimToken = (trackingRows.at(-1)!.payload as { claimToken: string }).claimToken;

    // At the origin r = D (same cached pair), so the claim liquidates the
    // whole work pool + the carrier bonus: 7 200 000 + 560 000.
    const claim = (await (
      await world.api({
        method: 'POST',
        url: `/shipments/${id}/claim`,
        cookie: world.rita.cookie,
        body: { claimToken },
        expect: 201,
      })
    ).json()) as { claimPaymentMsat: string };
    expect(claim.claimPaymentMsat).toBe('7760000');
  });
});
