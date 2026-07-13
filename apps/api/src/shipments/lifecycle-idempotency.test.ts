// Invariant 5 (ARCHITECTURE.md §5): wallet events and retries never
// duplicate money movements. Three layers are exercised: HTTP retries (the
// state flip rejects the second call), the wallet-event pump (a second pass
// is a no-op), and the ledger keys themselves (coordinator and executor
// write under the SAME cp:<paymentId>:<transizione> key, so the double write
// collapses — ADR-013 §3).

import { describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import {
  conditionalPayments,
  custodyEvents,
  journalEntries,
  shipmentTimers,
} from '@mercurio/db';
import { pumpWalletEvents } from './pump';
import { fireDueTimers } from './timers';
import { retryEscrowIntents } from './reconcile';
import {
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  sha,
  type LifecycleWorld,
} from './test-world';

async function bookAndPickup(world: LifecycleWorld) {
  const { id, qrToken } = await createShipmentAtHub(world);
  const tripId = await declareTrip(world, world.luca, -5, 50);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/legs`,
    cookie: world.luca.cookie,
    body: { tripId, toHubId: world.hubC },
    expect: 201,
  });
  world.clock.advanceMinutes(1);
  await pumpWalletEvents(world.app.lifecycle);
  await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);
  return { id, qrToken };
}

describe('retry and wallet-event idempotency', () => {
  it('the coordinator and the executor collapse onto one held entry per payment', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    // First pass: pollOnce posts cp:<id>:held (coordinator side) AND the
    // leg_funded transition posts the paired machine entries — same keys.
    await pumpWalletEvents(world.app.lifecycle);
    const cps = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.shipmentId, id));
    for (const cp of cps.filter((p) => p.state === 'held')) {
      const rows = await world.db
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.idempotencyKey, `cp:${cp.id}:held`));
      expect(rows).toHaveLength(1);
    }
  }, 30_000);

  it('a second pump pass is a no-op', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    const first = await pumpWalletEvents(world.app.lifecycle);
    expect(first.funded).toEqual([id]);
    const entriesAfterFirst = (await world.db.select().from(journalEntries)).length;

    const second = await pumpWalletEvents(world.app.lifecycle);
    expect(second.funded).toEqual([]);
    expect(second.observed).toEqual([]);
    expect((await world.db.select().from(journalEntries)).length).toBe(entriesAfterFirst);
  }, 30_000);

  it('a retried check-in gets 409 and moves nothing twice', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookAndPickup(world);
    world.clock.advanceMinutes(30);
    const body = { qrToken, photoSha256: [sha('c')], integrityConfirmed: true as const };
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body,
      expect: 200,
    });
    const lucaAfter = world.balance(world.luca);
    const entriesAfter = (await world.db.select().from(journalEntries)).length;

    // The retry finds IN_TRANSIT gone: illegal event → 409, nothing moves.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body,
      expect: 409,
    });
    expect(world.balance(world.luca)).toBe(lucaAfter);
    expect((await world.db.select().from(journalEntries)).length).toBe(entriesAfter);
  }, 30_000);

  it('a retried checkout confirmation after completion gets 409', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookAndPickup(world);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup-checkout`,
      cookie: world.luca.cookie,
      body: { qrToken },
      expect: 409, // LEG_BOOKED is gone: no booked leg to confirm
    });
  }, 30_000);

  it('a timer fires exactly once: the second sweep finds nothing', async () => {
    const world = await createLifecycleWorld();
    await createShipmentAtHub(world);
    world.clock.advanceHours(73);
    const first = await fireDueTimers(world.app.lifecycle);
    expect(first.fired).toBe(1);
    const second = await fireDueTimers(world.app.lifecycle);
    expect(second).toEqual({ fired: 0, stale: 0 });
    expect(await world.db.select().from(shipmentTimers)).toHaveLength(0);
  }, 30_000);

  it('a boost retried under the same idempotency key is applied once', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const body = { amountMsat: '1000000', idempotencyKey: 'boost-retry-1' };
    const first = await world.api({
      method: 'POST',
      url: `/shipments/${id}/boost`,
      cookie: world.marco.cookie,
      body,
      expect: 200,
    });
    expect((first.json() as { deduplicated: boolean }).deduplicated).toBe(false);
    const second = await world.api({
      method: 'POST',
      url: `/shipments/${id}/boost`,
      cookie: world.marco.cookie,
      body,
      expect: 200,
    });
    expect((second.json() as { deduplicated: boolean }).deduplicated).toBe(true);
    const boosts = await world.db
      .select()
      .from(custodyEvents)
      .where(and(eq(custodyEvents.shipmentId, id), eq(custodyEvents.type, 'boosted')));
    expect(boosts).toHaveLength(1);
  }, 30_000);

  it('a retried recipient pickup gets 409; the bonus settles exactly once', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookAndPickup(world);
    world.clock.advanceMinutes(30);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body: { qrToken, photoSha256: [sha('c')], integrityConfirmed: true },
      expect: 200,
    });
    const trip2 = await declareTrip(world, world.anna, 30, 105);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: trip2, toHubId: world.hubB },
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
      body: { qrToken, photoSha256: [sha('b')], integrityConfirmed: true },
      expect: 200,
    });
    const { emailOutbox } = await import('@mercurio/db');
    const otp = (
      (await world.db.select().from(emailOutbox)).find((r) => r.template === 'parcel_arrived')!
        .payload as { otp: string }
    ).otp;

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.bruno.cookie,
      body: { qrToken, otp },
      expect: 200,
    });
    const brunoAfter = world.balance(world.bruno);
    // DELIVERED released the stay: authorization already fails to find a
    // custodian hub (403) before the machine would say "terminal" (409) —
    // either way the retry moves nothing.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.bruno.cookie,
      body: { qrToken, otp },
      expect: 403,
    });
    expect(world.balance(world.bruno)).toBe(brunoAfter);
    const settled = await world.db
      .select()
      .from(journalEntries)
      .where(like(journalEntries.idempotencyKey, 'cp:%:settled'));
    // Exactly two settlements: the leg payments... plus the bonus = 3 for
    // this two-leg flow (leg1 payment, leg2 payment, Π_h).
    expect(settled).toHaveLength(3);
  }, 30_000);

  it('escrow-intent retry sweep is a safe no-op when nothing is pending', async () => {
    const world = await createLifecycleWorld();
    await createShipmentAtHub(world);
    expect(await retryEscrowIntents(world.app.lifecycle)).toEqual({ executed: 0, failed: 0 });
  }, 30_000);

  it('sender balance is untouched by a full retry storm on a delivered shipment', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookAndPickup(world);
    world.clock.advanceMinutes(30);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body: { qrToken, photoSha256: [sha('c')], integrityConfirmed: true },
      expect: 200,
    });
    const marcoAfter = world.balance(world.marco);
    // Replay every earlier step: each is rejected — by authorization (the
    // parcel now sits at hub C, Mario is no custodian: 403) or by state
    // (409) — and none moves funds.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/origin-checkin`,
      cookie: world.mario.cookie,
      body: { qrToken, photoSha256: [sha('x')] },
      expect: 403,
    });
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/origin-accept`,
      cookie: world.mario.cookie,
      expect: 409,
    });
    await pumpWalletEvents(world.app.lifecycle);
    await fireDueTimers(world.app.lifecycle);
    expect(world.balance(world.marco)).toBe(marcoAfter);
  }, 30_000);
});
