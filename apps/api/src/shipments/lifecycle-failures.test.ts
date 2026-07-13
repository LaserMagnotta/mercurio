// Failure paths of the lifecycle (ARCHITECTURE.md §5 rows 7, 10, 13, 14 and
// the funding-expiry arm of row 5), each on real fake-Lightning balances:
// slashes reach the pre-determined beneficiary, refunds reach the payer,
// nothing sticks to the platform, and the shipment aggregate closes clean.

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  conditionalPayments,
  emailOutbox,
  hubStays,
  legs,
  shipments,
  shipmentTimers,
} from '@mercurio/db';
import { pumpWalletEvents } from './pump';
import { fireDueTimers } from './timers';
import { reconcile } from './reconcile';
import {
  BOND_MSAT,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  INITIAL_BALANCE_MSAT,
  sha,
  type LifecycleWorld,
} from './test-world';

const LEG1_GROSS = 2_880_000n;
const LEG1_FEE = 288_000n;
const LEG2_HOLD = 4_880_000n; // gross 4 320 000 + Π_v 560 000
const HUB_BONUS = 240_000n;

/** Shortcut to a booked first leg (A→C, funded, LEG_BOOKED). */
async function bookFirstLeg(world: LifecycleWorld) {
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
  const { funded } = await pumpWalletEvents(world.app.lifecycle);
  expect(funded).toEqual([id]);
  return { id, qrToken };
}

/** Shortcut to AWAITING_PICKUP at hub B with the Π_h hold pending. */
async function reachAwaitingPickup(world: LifecycleWorld) {
  const { id, qrToken } = await createShipmentAtHub(world);
  const trip1 = await declareTrip(world, world.luca, -5, 50);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/legs`,
    cookie: world.luca.cookie,
    body: { tripId: trip1, toHubId: world.hubC },
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
  return { id, qrToken };
}

async function shipmentStatus(world: LifecycleWorld, id: string) {
  const [row] = await world.db.select().from(shipments).where(eq(shipments.id, id));
  return row!.status;
}

describe('lifecycle failure paths', () => {
  it('leg funding expiry: every hold dissolves, the shipment returns to the board', async () => {
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
    // Funds are already in flight toward the holds...
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - LEG1_GROSS);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);

    // ...but the window closes with no leg_funded: the timer dissolves it all.
    world.clock.advanceMinutes(61);
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('at_hub');
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT);
    const [legRow] = await world.db.select().from(legs).where(eq(legs.shipmentId, id));
    expect(legRow!.status).toBe('expired');
    // A late pump finds nothing pending: the expiry is final.
    const { funded } = await pumpWalletEvents(world.app.lifecycle);
    expect(funded).toEqual([]);
    // The parcel is back on the board for the next carrier.
    const trip2 = await declareTrip(world, world.anna, 30, 105);
    const board = await world.api({
      method: 'GET',
      url: `/trips/${trip2}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    expect((board.json() as { cards: unknown[] }).cards).toHaveLength(1);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('pickup timeout: carrier bond slashed to the sender, storage resumes with its ORIGINAL deadline', async () => {
    const world = await createLifecycleWorld();
    const { id } = await bookFirstLeg(world);
    const [origStay] = await world.db
      .select()
      .from(hubStays)
      .where(and(eq(hubStays.shipmentId, id), eq(hubStays.status, 'active')));
    const originalDeadline = origStay!.storageDeadlineAt!.getTime();

    world.clock.advanceHours(25); // pickup window is 24 h
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('at_hub');
    // Slash: the sender collects Luca's bond directly (ADR-012); his own
    // leg payment came back; hub C's bond dissolved.
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT + BOND_MSAT);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT);
    const [legRow] = await world.db.select().from(legs).where(eq(legs.shipmentId, id));
    expect(legRow!.status).toBe('failed');
    // Storage re-armed with the deadline it had before the booking paused it.
    const [timer] = await world.db
      .select()
      .from(shipmentTimers)
      .where(and(eq(shipmentTimers.shipmentId, id), eq(shipmentTimers.kind, 'storage')));
    expect(timer!.fireAt.getTime()).toBe(originalDeadline);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('transit timeout: LOST, bond slashed, on-the-spot fees stay paid', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookFirstLeg(world);
    await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);

    world.clock.advanceHours(49); // transit window is 48 h
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('lost');
    // The departure fee was paid at the physical handoff and stays paid.
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE);
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT + BOND_MSAT);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT - LEG1_FEE);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT);
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect(await world.db.select().from(shipmentTimers)).toHaveLength(0);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('storage expiry at the origin hub: FORFEITED, the parcel itself compensates the hub', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);

    world.clock.advanceHours(73); // sender chose 72 h
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('forfeited');
    // No prefunded pot exists (ADR-013): the bond simply dissolves and the
    // forfeited parcel is the hub's compensation under the ToS.
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT);
    expect(await world.commitmentBalance(id)).toBe(0n);
  }, 30_000);

  it('storage expiry in AWAITING_PICKUP: the Π_h hold returns to the sender', async () => {
    const world = await createLifecycleWorld();
    const { id } = await reachAwaitingPickup(world);
    expect(await shipmentStatus(world, id)).toBe('awaiting_pickup');

    world.clock.advanceHours(73);
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('forfeited');
    // The sender paid the two leg holds (leg 2 includes Π_v) but the hub
    // bonus came back: the hub is compensated by the parcel, never by Π_h.
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - LEG1_GROSS - LEG2_HOLD);
    const [bonusRow] = await world.db
      .select()
      .from(conditionalPayments)
      .where(
        and(
          eq(conditionalPayments.shipmentId, id),
          eq(conditionalPayments.purpose, 'finalization_bonus'),
        ),
      );
    expect(bonusRow!.state).toBe('cancelled');
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('leg return: everything dissolves, the re-accepting hub posts a FRESH bond', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await bookFirstLeg(world);
    await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE);

    world.clock.advanceMinutes(30);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/return`,
      cookie: world.mario.cookie,
      body: { qrToken, photoSha256: [sha('return')] },
      expect: 200,
    });

    expect(await shipmentStatus(world, id)).toBe('at_hub');
    // Payment and carrier bond dissolved (nobody collects, ADR-012); the
    // dep fee stays paid; Mario re-binds a fresh bond for the new custody.
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT - LEG1_FEE);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE - BOND_MSAT);
    const stays = await world.db.select().from(hubStays).where(eq(hubStays.shipmentId, id));
    expect(stays.filter((s) => s.status === 'active')).toHaveLength(1);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('cancel at the origin hub: f_o × work pool paid to the hub, parcel released', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/cancel`,
      cookie: world.marco.cookie,
      expect: 200,
    });

    expect(await shipmentStatus(world, id)).toBe('cancelled');
    // Compensation = 10% × 7 200 000 (the WORK pool: the finalization bonus
    // is excluded from this formula too — ADR-014).
    const compensation = 720_000n;
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - compensation);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + compensation);
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect(await world.db.select().from(shipmentTimers)).toHaveLength(0);
  }, 30_000);

  it('reroute from AWAITING_PICKUP: Π_h refunded, new final leg has a fresh Π_h and NO carrier share', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await reachAwaitingPickup(world);
    const marcoAfterDelivery = INITIAL_BALANCE_MSAT - LEG1_GROSS - LEG2_HOLD - HUB_BONUS;
    expect(world.balance(world.marco)).toBe(marcoAfterDelivery);
    const firstArrivalOtp = (
      (await world.db.select().from(emailOutbox)).find((r) => r.template === 'parcel_arrived')!
        .payload as { otp: string }
    ).otp;

    // The sender reroutes the delivery to hub C (destination change).
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/reroute`,
      cookie: world.marco.cookie,
      body: { newDestHubId: world.hubC },
      expect: 200,
    });
    expect(await shipmentStatus(world, id)).toBe('at_hub');
    // Π_h came back: the premium follows the parcel (ADR-014 §5).
    expect(world.balance(world.marco)).toBe(marcoAfterDelivery + HUB_BONUS);

    // Pool exhausted at the old destination: the reroute REQUIRES a boost
    // (ECONOMICS.md §5) before any carrier can be paid.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/boost`,
      cookie: world.marco.cookie,
      body: { amountMsat: '2000000', idempotencyKey: 'boost-after-reroute' },
      expect: 200,
    });

    // Anna carries it back B→C: Π_v was consumed by the first arrival —
    // the new final leg carries NO carrier share (the cost of the sender's
    // change of mind), but a fresh Π_h toward the NEW destination hub.
    const trip3 = await declareTrip(world, world.anna, 95, 35);
    const leg3 = await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: trip3, toHubId: world.hubC },
      expect: 201,
    });
    const leg3Body = leg3.json() as {
      pricing: Record<string, string>;
      finalizationHubBonusMsat: string;
    };
    // Boost work part 1 800 000 spread over the fresh 60 km segment.
    expect(leg3Body.pricing.grossMsat).toBe('1800000');
    expect(leg3Body.pricing.finalizationBonusMsat).toBe('0'); // Π_v consumed
    // Fresh Π_h = accrued hub quota: 240 000 (offer) + 60 000 (boost).
    expect(leg3Body.finalizationHubBonusMsat).toBe('300000');

    world.clock.advanceMinutes(1);
    const { funded } = await pumpWalletEvents(world.app.lifecycle);
    expect(funded).toEqual([id]);
    await doubleConfirmCheckout(world, id, qrToken, world.bruno, world.anna);
    world.clock.advanceMinutes(30);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body: { qrToken, photoSha256: [sha('back-at-c')], integrityConfirmed: true },
      expect: 200,
    });

    // The first arrival's OTP was rotated away by the reroute; only the one
    // from the SECOND arrival email can collect.
    const arrivalMails = (await world.db.select().from(emailOutbox)).filter(
      (r) => r.template === 'parcel_arrived',
    );
    expect(arrivalMails).toHaveLength(2);
    const newOtp = (arrivalMails.at(-1)!.payload as { otp: string }).otp;
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.carla.cookie,
      body: { qrToken, otp: firstArrivalOtp },
      expect: 422,
    });
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.carla.cookie,
      body: { qrToken, otp: newOtp },
      expect: 200,
    });

    expect(await shipmentStatus(world, id)).toBe('delivered');
    // Conservation across offer + boost: Marco paid every settled hold and
    // kept the unspent Π_v accrual of the boost (140 000 msat).
    expect(world.balance(world.marco)).toBe(
      INITIAL_BALANCE_MSAT - LEG1_GROSS - LEG2_HOLD - 1_800_000n - 300_000n,
    );
    // Hub C: arrival fee of leg 1 (288 000) + departure fee of leg 2
    // (432 000) + arrival fee of leg 3 (180 000) + fresh Π_h (300 000).
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT + 1_200_000n);
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('recipient-only reroute keeps Π_h: the same hub still completes the delivery', async () => {
    const world = await createLifecycleWorld();
    const { id, qrToken } = await reachAwaitingPickup(world);

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/reroute`,
      cookie: world.marco.cookie,
      body: { newRecipientEmail: 'nuova@test.local' },
      expect: 200,
    });
    expect(await shipmentStatus(world, id)).toBe('awaiting_pickup');
    const [bonusRow] = await world.db
      .select()
      .from(conditionalPayments)
      .where(
        and(
          eq(conditionalPayments.shipmentId, id),
          eq(conditionalPayments.purpose, 'finalization_bonus'),
        ),
      );
    expect(bonusRow!.state).toBe('held'); // NOT refunded: this hub delivers

    // The fresh OTP went straight to the NEW recipient.
    const arrivalMails = (await world.db.select().from(emailOutbox)).filter(
      (r) => r.template === 'parcel_arrived',
    );
    expect(arrivalMails).toHaveLength(2);
    expect(arrivalMails.at(-1)!.to).toBe('nuova@test.local');
    const newOtp = (arrivalMails.at(-1)!.payload as { otp: string }).otp;

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.bruno.cookie,
      body: { qrToken, otp: newOtp },
      expect: 200,
    });
    // Hub B completed the delivery and earned its Π_h.
    expect(world.balance(world.bruno)).toBe(INITIAL_BALANCE_MSAT + 432_000n + HUB_BONUS);
  }, 30_000);
});
