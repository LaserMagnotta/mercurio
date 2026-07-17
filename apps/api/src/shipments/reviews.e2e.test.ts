// Reviews (CLAUDE.md "Recensioni", ADR-017), end to end over HTTP on pglite.
//
// Reviews move no money, but they weigh on reputation — the only sanction in
// a system without arbiters (RISKS.md §1) — so every guard is tested one by
// one: closed shipment, review window, effective-role rules for carriers
// (funded legs only), hubs (certified check-in only) and claimants (funded
// claims only, as 'carrier' — ADR-016), self-review, double review. The
// aggregates are asserted on every surface where a counterparty is chosen:
// hub list, board card, shipment detail, profile endpoint.

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
    ratings: { sender: RatingDto; carrier: RatingDto; hub: RatingDto };
    reviews: { authorId: string; role: string; stars: number; comment: string | null }[];
  };
}

/** Canonical delivery (CLAUDE.md flow): Luca A→C, Anna C→B, OTP pickup. */
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

describe('reviews (ADR-017)', () => {
  it('delivered shipment: participants review each other, aggregates surface everywhere', async () => {
    const world = await createLifecycleWorld();
    const { id } = await deliverCanonical(world);

    // Cross-reviews between effective participants, per role.
    await postReview(world, world.marco, id, {
      subjectId: world.luca.id,
      role: 'carrier',
      stars: 5,
      comment: 'puntuale e gentile',
    }, 201);
    await postReview(world, world.marco, id, { subjectId: world.anna.id, role: 'carrier', stars: 4 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 201);
    await postReview(world, world.luca, id, { subjectId: world.mario.id, role: 'hub', stars: 3 }, 201);
    await postReview(world, world.luca, id, { subjectId: world.marco.id, role: 'sender', stars: 4 }, 201);
    await postReview(world, world.bruno, id, { subjectId: world.marco.id, role: 'sender', stars: 5 }, 201);

    // Profile endpoint: per-role aggregates + received list, newest first.
    const luca = await userReviews(world, world.luca.id);
    expect(luca.ratings.carrier).toEqual({ averageStars: 5, reviewCount: 1 });
    expect(luca.ratings.hub).toEqual({ averageStars: null, reviewCount: 0 });
    expect(luca.reviews).toHaveLength(1);
    expect(luca.reviews[0]).toMatchObject({
      authorId: world.marco.id,
      role: 'carrier',
      stars: 5,
      comment: 'puntuale e gentile',
    });
    const marco = await userReviews(world, world.marco.id);
    expect(marco.ratings.sender).toEqual({ averageStars: 4.5, reviewCount: 2 });

    // Hub list: the sender picks hubs here — ratings ride along.
    const hubList = (await (
      await world.api({ method: 'GET', url: '/hubs', expect: 200 })
    ).json()) as { hubs: { id: string; rating: RatingDto }[] };
    const hubRating = (hubId: string) => hubList.hubs.find((h) => h.id === hubId)!.rating;
    expect(hubRating(world.hubC)).toEqual({ averageStars: 5, reviewCount: 1 });
    expect(hubRating(world.hubA)).toEqual({ averageStars: 3, reviewCount: 1 });
    expect(hubRating(world.hubB)).toEqual({ averageStars: null, reviewCount: 0 });

    // Shipment detail: per-role ratings of every effective participant.
    const detail = (await (
      await world.api({
        method: 'GET',
        url: `/shipments/${id}`,
        cookie: world.marco.cookie,
        expect: 200,
      })
    ).json()) as { ratings: { userId: string; role: string; hubId: string | null }[] };
    expect(detail.ratings).toContainEqual({
      userId: world.luca.id,
      role: 'carrier',
      hubId: null,
      averageStars: 5,
      reviewCount: 1,
    });
    expect(detail.ratings).toContainEqual({
      userId: world.carla.id,
      role: 'hub',
      hubId: world.hubC,
      averageStars: 5,
      reviewCount: 1,
    });

    // Board card of a NEW shipment by the same sender: senderRating and the
    // ratings of the hubs involved (MATCHING.md §3).
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
      cards: {
        senderRating: RatingDto;
        currentHubRating: RatingDto;
        bestDropHub: { hubId: string; hubRating: RatingDto };
      }[];
    };
    expect(board.cards).toHaveLength(1);
    expect(board.cards[0]!.senderRating).toEqual({ averageStars: 4.5, reviewCount: 2 });
    expect(board.cards[0]!.currentHubRating).toEqual({ averageStars: 3, reviewCount: 1 });
    expect(board.cards[0]!.bestDropHub.hubRating).toEqual({ averageStars: 5, reviewCount: 1 });
  }, 30_000);

  it('guards, one by one', async () => {
    const world = await createLifecycleWorld();
    const { id } = await deliverCanonical(world);

    // Author must be an effective participant (Rita never claimed).
    await postReview(world, world.rita, id, { subjectId: world.luca.id, role: 'carrier', stars: 5 }, 403);
    // No self-reviews.
    await postReview(world, world.marco, id, { subjectId: world.marco.id, role: 'sender', stars: 5 }, 422);
    // The subject must have held THAT role effectively.
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'hub', stars: 5 }, 422);
    await postReview(world, world.marco, id, { subjectId: world.rita.id, role: 'carrier', stars: 5 }, 422);
    // One review per (shipment, author, subject, role) — DB unique.
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 5 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 1 }, 409);
    // Stars are 1..5 (zod, then the DB check as backstop).
    await postReview(world, world.marco, id, { subjectId: world.anna.id, role: 'carrier', stars: 6 }, 400);
    await postReview(world, world.marco, id, { subjectId: world.anna.id, role: 'carrier', stars: 0 }, 400);
    // Unknown shipment.
    await postReview(world, world.marco, '00000000-0000-4000-8000-000000000000', {
      subjectId: world.luca.id,
      role: 'carrier',
      stars: 5,
    }, 404);

    // Open shipments cannot be reviewed (AT_HUB is not closed).
    const open = await createShipmentAtHub(world);
    await postReview(world, world.marco, open.id, { subjectId: world.mario.id, role: 'hub', stars: 5 }, 409);

    // The window closes REVIEW_WINDOW_DAYS after the closing custody event.
    world.clock.advanceHours(31 * 24);
    await postReview(world, world.marco, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 409);
  }, 30_000);

  it('failure paths: funded engagements are reviewable, dissolved ones are not', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);

    // Anna accepts a leg but never funds it: the acceptance dissolves alone.
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
    // bond — a funded engagement, the one reputation must record.
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

    // Storage expires (72 h from check-in): the shipment closes FORFEITED —
    // a terminal state, reviewable like any other closure (ADR-017).
    world.clock.advanceHours(72);
    await fireDueTimers(world.app.lifecycle);

    await postReview(world, world.marco, id, { subjectId: world.luca.id, role: 'carrier', stars: 1 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.mario.id, role: 'hub', stars: 4 }, 201);
    await postReview(world, world.luca, id, { subjectId: world.marco.id, role: 'sender', stars: 2 }, 201);
    // Never-funded engagements never happened, for reviews too.
    await postReview(world, world.marco, id, { subjectId: world.anna.id, role: 'carrier', stars: 1 }, 422);
    await postReview(world, world.marco, id, { subjectId: world.rita.id, role: 'carrier', stars: 1 }, 422);
    // The destination hub never hosted the parcel: no role, in or out.
    await postReview(world, world.marco, id, { subjectId: world.bruno.id, role: 'hub', stars: 1 }, 422);
    await postReview(world, world.anna, id, { subjectId: world.marco.id, role: 'sender', stars: 5 }, 403);
  }, 30_000);

  it('a funded claimant is reviewable as carrier, and can review (ADR-016)', async () => {
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

    // Rita did the residual leg herself (ADR-016): she is a 'carrier' both
    // as a subject and as an author.
    await postReview(world, world.carla, id, { subjectId: world.rita.id, role: 'carrier', stars: 5 }, 201);
    await postReview(world, world.marco, id, { subjectId: world.rita.id, role: 'carrier', stars: 4 }, 201);
    await postReview(world, world.rita, id, { subjectId: world.carla.id, role: 'hub', stars: 5 }, 201);
    const rita = await userReviews(world, world.rita.id);
    expect(rita.ratings.carrier).toEqual({ averageStars: 4.5, reviewCount: 2 });
  }, 30_000);
});
