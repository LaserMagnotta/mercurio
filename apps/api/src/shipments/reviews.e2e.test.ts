// Reviews (CLAUDE.md "Recensioni", ADR-017 as amended by ADR-027), end to end
// over HTTP on pglite.
//
// Only the HUB is reviewable now (ADR-027): the enum still carries
// sender/carrier, but the API refuses them and no read surfaces their
// aggregates. Reviews move no money, but they weigh on reputation — the only
// sanction in a system without arbiters (RISKS.md §1) — so every guard is
// tested one by one: closed shipment, review window, author is an effective
// participant, subject is a HUB that certified a check-in, non-hub subjects
// refused, self-review, double review. The hub aggregates are asserted on
// every surface where a hub is chosen: hub list, board card, shipment detail,
// profile endpoint.

import { describe, expect, it } from 'vitest';
import { emailOutbox } from '@mercurio/db';
import { pumpWalletEvents } from './pump.js';
import { fireDueTimers } from './timers.js';
import {
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  sha,
  type LifecycleWorld,
  type Persona,
} from './test-world.js';

interface RatingDto {
  averageStars: number | null;
  reviewCount: number;
}

async function postReview(
  world: LifecycleWorld,
  author: Persona,
  shipmentId: string,
  body: { subjectId: string; role: 'sender' | 'carrier' | 'hub'; stars: number; comment?: string },
  expectStatus: number,
): Promise<unknown> {
  const res = await world.api({
    method: 'POST',
    url: `/shipments/${shipmentId}/reviews`,
    cookie: author.cookie,
    body,
    expect: expectStatus,
  });
  return res.json();
}

async function userReviews(world: LifecycleWorld, userId: string) {
  const res = await world.api({ method: 'GET', url: `/users/${userId}/reviews`, expect: 200 });
  return res.json() as {
    userId: string;
    ratings: { hub: RatingDto };
    reviews: { authorId: string; role: string; stars: number; comment: string | null }[];
  };
}

/** Canonical delivery (CLAUDE.md flow): Luca A→C, Anna C→B, OTP pickup. All
 *  three hubs certify a check-in, so all three are reviewable as hubs. */
async function deliverCanonical(world: LifecycleWorld): Promise<{ id: string }> {
  const { id, qrToken } = await createShipmentAtHub(world);
  const lucaTrip = await declareTrip(world, world.luca, -5, 50);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/legs`,
    cookie: world.luca.cookie,
    body: { tripId: lucaTrip, toHubId: world.hubC },
    expect: 201,
  });
  world.clock.advanceMinutes(1);
  await pumpWalletEvents(world.app.lifecycle);
  await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);
  world.clock.advanceMinutes(30);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/checkin`,
    cookie: world.carla.cookie,
    body: { qrToken, photoSha256: [sha('checkin-c')], integrityConfirmed: true },
    expect: 200,
  });
  const annaTrip = await declareTrip(world, world.anna, 30, 105);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/legs`,
    cookie: world.anna.cookie,
    body: { tripId: annaTrip, toHubId: world.hubB },
    expect: 201,
  });
  world.clock.advanceMinutes(1);
  await pumpWalletEvents(world.app.lifecycle);
  await doubleConfirmCheckout(world, id, qrToken, world.carla, world.anna);
  world.clock.advanceMinutes(30);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/checkin`,
    cookie: world.bruno.cookie,
    body: { qrToken, photoSha256: [sha('checkin-b')], integrityConfirmed: true },
    expect: 200,
  });
  const outboxRows = await world.db.select().from(emailOutbox);
  const otp = (
    outboxRows.find((r) => r.template === 'parcel_arrived')!.payload as { otp: string }
  ).otp;
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/pickup`,
    cookie: world.bruno.cookie,
    body: { qrToken, otp },
    expect: 200,
  });
  return { id };
}

/** The claim token from the LAST tracking mail in the outbox (ADR-016). */
async function lastClaimToken(world: LifecycleWorld): Promise<string> {
  const rows = (await world.db.select().from(emailOutbox)).filter(
    (r) => r.template === 'parcel_tracking',
  );
  return (rows.at(-1)!.payload as { claimToken: string }).claimToken;
}

describe('reviews (ADR-017, hub-only per ADR-027)', () => {
  it('delivered shipment: participants review the hubs, hub aggregates surface everywhere', async () => {
    const world = await createLifecycleWorld();
    const { id } = await deliverCanonical(world);

    // Effective participants review the HUBS. carla (hub C) gets two reviews,
    // mario (hub A) one; the averages are asserted below.
    await postReview(world, world.marco, id, {
      subjectId: world.carla.id,
      role: 'hub',
      stars: 5,
      comment: 'hub curato e reattivo',
    }, 201);
    await postReview(world, world.luca, id, { subjectId: world.carla.id, role: 'hub', stars: 4 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 3 }, 201);
    // Non-hub subjects are refused now (ADR-027) — the enum still parses, the
    // API is the judge.
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 5 }, 422);
    await postReview(world, world.luca, id, { subjectId: world.marco.id, role: 'sender', stars: 4 }, 422);

    // Profile endpoint: a single hub aggregate + the received hub reviews.
    const carla = await userReviews(world, world.carla.id);
    expect(carla.ratings.hub).toEqual({ averageStars: 4.5, reviewCount: 2 });
    expect(carla.reviews).toHaveLength(2);
    expect(carla.reviews[0]).toMatchObject({ role: 'hub' });
    // A carrier/sender profile carries no non-hub aggregate anymore.
    const luca = await userReviews(world, world.luca.id);
    expect(luca.ratings.hub).toEqual({ averageStars: null, reviewCount: 0 });
    expect(luca.reviews).toHaveLength(0);

    // Hub list: the sender picks hubs here — ratings ride along.
    const hubList = (await (
      await world.api({ method: 'GET', url: '/hubs', expect: 200 })
    ).json()) as { hubs: { id: string; rating: RatingDto }[] };
    const hubRating = (hubId: string) => hubList.hubs.find((h) => h.id === hubId)!.rating;
    expect(hubRating(world.hubC)).toEqual({ averageStars: 4.5, reviewCount: 2 });
    expect(hubRating(world.hubA)).toEqual({ averageStars: 3, reviewCount: 1 });
    expect(hubRating(world.hubB)).toEqual({ averageStars: null, reviewCount: 0 });

    // Shipment detail: hub participants only, plus the viewer's authorship flag.
    const detail = (await (
      await world.api({
        method: 'GET',
        url: `/shipments/${id}`,
        cookie: world.marco.cookie,
        expect: 200,
      })
    ).json()) as {
      ratings: { userId: string; role: string; hubId: string | null }[];
      viewerCanReview: boolean;
    };
    expect(detail.viewerCanReview).toBe(true);
    // Every displayed rating is a hub — never a sender or carrier.
    expect(detail.ratings.every((r) => r.role === 'hub')).toBe(true);
    expect(detail.ratings).toContainEqual({
      userId: world.carla.id,
      role: 'hub',
      hubId: world.hubC,
      averageStars: 4.5,
      reviewCount: 2,
    });

    // Board card of a NEW shipment by the same sender: hub ratings only, and
    // NO senderRating field anymore (MATCHING.md §3, ADR-027).
    await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);
    const board = (await (
      await world.api({
        method: 'GET',
        url: `/trips/${tripId}/board`,
        cookie: world.luca.cookie,
        expect: 200,
      })
    ).json()) as {
      cards: (Record<string, unknown> & {
        currentHubRating: RatingDto;
        bestDropHub: { hubId: string; hubRating: RatingDto };
      })[];
    };
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]!.senderRating).toBeUndefined();
    expect(board.cards[0]!.currentHubRating).toEqual({ averageStars: 3, reviewCount: 1 });
    expect(board.cards[0]!.bestDropHub.hubRating).toEqual({ averageStars: 4.5, reviewCount: 2 });
  }, 30_000);

  it('guards, one by one', async () => {
    const world = await createLifecycleWorld();
    const { id } = await deliverCanonical(world);

    // Author must be an effective participant (Rita never claimed).
    await postReview(world, world.rita, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 403);
    // Non-hub subjects are refused (ADR-027) — before self-review, before the
    // effective-role check.
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 5 }, 422);
    await postReview(world, world.marco, id, { subjectId: world.marco.id, role: 'sender', stars: 5 }, 422);
    // A hub owner cannot review their own hub (self-review).
    await postReview(world, world.mario, id, { subjectId: world.mario.id, role: 'hub', stars: 5 }, 422);
    // The subject must have held the HUB role effectively (Luca is no hub).
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'hub', stars: 5 }, 422);
    // One review per (shipment, author, subject, role) — DB unique.
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 1 }, 409);
    // Stars are 1..5 (zod, then the DB check as backstop).
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 6 }, 400);
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 0 }, 400);
    // Unknown shipment.
    await postReview(world, world.marco, '00000000-0000-4000-8000-000000000000', {
      subjectId: world.carla.id,
      role: 'hub',
      stars: 5,
    }, 404);

    // Open shipments cannot be reviewed (AT_HUB is not closed).
    const open = await createShipmentAtHub(world);
    await postReview(world, world.marco, open.id, { subjectId: world.mario.id, role: 'hub', stars: 5 }, 409);

    // The window closes REVIEW_WINDOW_DAYS after the closing custody event.
    world.clock.advanceHours(31 * 24);
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 5 }, 409);
  }, 30_000);

  it('failure paths: only hubs that certified a check-in are reviewable', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);

    // Anna accepts a leg but never funds it: the acceptance dissolves alone —
    // she never becomes a participant.
    const annaTrip = await declareTrip(world, world.anna, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: annaTrip, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(61);
    await fireDueTimers(world.app.lifecycle);

    // Luca funds his leg and then never shows up: pickup_timeout slashes his
    // bond. Hub C was only his (never-reached) arrival hub — it never hosted.
    const lucaTrip = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId: lucaTrip, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    world.clock.advanceHours(25);
    await fireDueTimers(world.app.lifecycle);

    // Rita claims but the funding window lapses: the claim dissolves alone.
    const claimToken = await lastClaimToken(world);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    world.clock.advanceMinutes(61);
    await fireDueTimers(world.app.lifecycle);

    // Storage expires (72 h from check-in): the shipment closes FORFEITED — a
    // terminal state, reviewable like any other closure (ADR-017). Only hub A
    // (Mario) ever certified a check-in.
    world.clock.advanceHours(72);
    await fireDueTimers(world.app.lifecycle);

    // The one hosted hub is reviewable.
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 4 }, 201);
    // Non-hub subjects are refused outright (ADR-027).
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 1 }, 422);
    await postReview(world, world.luca, id, { subjectId: world.marco.id, role: 'sender', stars: 2 }, 422);
    // A hub that never hosted the parcel has no hub role: not reviewable.
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 1 }, 422);
    await postReview(world, world.marco, id, { subjectId: world.bruno.id, role: 'hub', stars: 1 }, 422);
    // Anna never funded her leg: not a participant, cannot author.
    await postReview(world, world.anna, id, { subjectId: world.mario.id, role: 'hub', stars: 5 }, 403);
  }, 30_000);

  it('a funded claimant can author hub reviews but is not a reviewable subject (ADR-016/027)', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await createShipmentAtHub(world);
    const lucaTrip = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId: lucaTrip, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);
    world.clock.advanceMinutes(30);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body: { qrToken, photoSha256: [sha('checkin-c')], integrityConfirmed: true },
      expect: 200,
    });

    const claimToken = await lastClaimToken(world);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.carla.cookie,
      body: { qrToken, claimToken },
      expect: 200,
    });

    // Rita (the claimant) is an effective participant: she can AUTHOR a hub
    // review. She is not a reviewable subject — no one is, except the hubs.
    await postReview(world, world.rita, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 4 }, 201);
    await postReview(world, world.carla, id, { subjectId: world.rita.id, role: 'carrier', stars: 5 }, 422);

    const carla = await userReviews(world, world.carla.id);
    expect(carla.ratings.hub).toEqual({ averageStars: 4.5, reviewCount: 2 });
  }, 30_000);
});
