// Recipient claim (ADR-016), end to end over HTTP on pglite + the fake
// Lightning network. The canonical scenario extends the CLAUDE.md example:
// Luca carries A→C (40 km of 100), then Rita — the recipient, holding the
// bearer token from her tracking mail — claims the parcel at hub C. She
// collects the remaining work pool PLUS the unconsumed carrier bonus share
// (she finishes the carriage herself); hub C collects the accrued Π_h; the
// sender pays exactly 5.00 €, to the msat, and the platform touches nothing.
//
// Every figure is asserted on REAL fake-network wallet balances — funds move
// only on settle/cancel with the true preimage, so the numbers cannot lie.

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  accounts,
  conditionalPayments,
  custodyEvents,
  emailOutbox,
  journalEntries,
  shipmentClaims,
  shipments,
  shipmentTimers,
} from '@mercurio/db';
import { verifyCustodyChain } from '@mercurio/core';
import { pumpWalletEvents } from './pump';
import { fireDueTimers } from './timers';
import { dispatchEmailOutbox } from './outbox';
import { reconcile } from './reconcile';
import { orderCustodyChain } from './context';
import {
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  INITIAL_BALANCE_MSAT,
  sha,
  type LifecycleWorld,
} from './test-world';

// ECONOMICS.md §5-ter / ADR-016, at 1600 sats/€ (all msat):
const LEG1_GROSS = 2_880_000n; // 1.80 € — Luca's leg A→C on the work pool
const LEG1_FEE = 288_000n; // 0.18 € per adjacent hub
const LUCA_NET = 2_304_000n; // 1.44 €
const REMAINING_POOL_AT_C = 4_320_000n; // 2.70 € — 60/100 of the work pool
const CARRIER_BONUS = 560_000n; // Π_v 0.35 €, unconsumed: Rita collects it
const HUB_BONUS = 240_000n; // Π_h 0.15 € to the pickup hub
const CLAIM_AT_C = REMAINING_POOL_AT_C + CARRIER_BONUS; // 3.05 € = 4 880 000
const CLAIM_AT_ORIGIN = 7_200_000n + CARRIER_BONUS; // 4.85 € = 7 760 000

/** The claim token from the LAST tracking mail in the outbox. */
async function lastClaimToken(world: LifecycleWorld): Promise<string> {
  const rows = (await world.db.select().from(emailOutbox)).filter(
    (r) => r.template === 'parcel_tracking',
  );
  expect(rows.length).toBeGreaterThan(0);
  return (rows.at(-1)!.payload as { claimToken: string }).claimToken;
}

async function shipmentStatus(world: LifecycleWorld, id: string) {
  const [row] = await world.db.select().from(shipments).where(eq(shipments.id, id));
  return row!.status;
}

/** Canonical first leg: Luca carries A→C, parcel idle AT_HUB at C. */
async function carryToC(world: LifecycleWorld) {
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
  world.clock.advanceMinutes(30);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/checkin`,
    cookie: world.carla.cookie,
    body: { qrToken, photoSha256: [sha('checkin-c')], integrityConfirmed: true },
    expect: 200,
  });
  return { id, qrToken };
}

describe('recipient claim (ADR-016)', () => {
  it('canonical claim at hub C: Rita collects pool + Π_v, Carla Π_h, Marco pays 5.00 € exactly', async () => {
    const world = await createLifecycleWorld();
    const { api, clock, db } = world;
    const { id, qrToken } = await carryToC(world);
    const claimToken = await lastClaimToken(world);

    // --- Rita claims with the bearer token from her tracking mail ---------
    const claimRes = await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    const claim = claimRes.json() as {
      claimId: string;
      status: string;
      claimPaymentMsat: string;
      hubBonusMsat: string;
    };
    expect(claim.status).toBe('pending_funding');
    expect(claim.claimPaymentMsat).toBe(CLAIM_AT_C.toString()); // 3.05 €
    expect(claim.hubBonusMsat).toBe(HUB_BONUS.toString()); // 0.15 €

    // From the request on, the parcel is OFF the board and no leg books.
    const annaTrip = await declareTrip(world, world.anna, 30, 105);
    const board = await api({
      method: 'GET',
      url: `/trips/${annaTrip}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    expect((board.json() as { cards: unknown[] }).cards).toEqual([]);
    await api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: annaTrip, toHubId: world.hubB },
      expect: 422,
    });
    // A second claim request is rejected too: one live claim per shipment.
    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 422,
    });

    // --- funding: the wallet pump books the claim (CLAIMED) ---------------
    clock.advanceMinutes(1);
    const pump = await pumpWalletEvents(world.app.lifecycle);
    expect(pump.funded).toEqual([id]);
    expect(await shipmentStatus(world, id)).toBe('claimed');
    // Marco's wallet committed claim payment + Π_h on top of Luca's leg.
    expect(world.balance(world.marco)).toBe(
      INITIAL_BALANCE_MSAT - LEG1_GROSS - CLAIM_AT_C - HUB_BONUS,
    );
    // A second pump pass is a no-op (idempotency, invariant 5).
    const pumpAgain = await pumpWalletEvents(world.app.lifecycle);
    expect(pumpAgain.funded).toEqual([]);

    // --- physical pickup: Carla's session + parcel QR + Rita's token ------
    clock.advanceMinutes(30);
    await api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.carla.cookie,
      body: { qrToken, claimToken },
      expect: 200,
    });

    // --- the money: every figure of ECONOMICS.md §5-ter, on real wallets --
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - 8_000_000n); // 5.00 € exactly
    expect(world.balance(world.rita)).toBe(INITIAL_BALANCE_MSAT + CLAIM_AT_C); // +3.05 €
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT + LUCA_NET); // +1.44 €
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE); // +0.18 €
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE + HUB_BONUS); // +0.33 €
    expect(world.balance(world.bruno)).toBe(INITIAL_BALANCE_MSAT); // never involved

    // --- aggregate closed clean -------------------------------------------
    expect(await shipmentStatus(world, id)).toBe('delivered');
    expect(await world.commitmentBalance(id)).toBe(0n); // invariant 2
    const [claimRow] = await db.select().from(shipmentClaims).where(eq(shipmentClaims.id, claim.claimId));
    expect(claimRow!.status).toBe('completed');
    expect(claimRow!.claimantId).toBe(world.rita.id);
    const cps = await db.select().from(conditionalPayments);
    expect(cps).toHaveLength(6); // origin bond, 3 leg holds, claim payment, Π_h
    expect(cps.filter((p) => p.state === 'settled')).toHaveLength(3); // leg1 payment, claim, Π_h
    expect(cps.filter((p) => p.state === 'cancelled')).toHaveLength(3); // the three bonds
    expect(await db.select().from(shipmentTimers)).toHaveLength(0);

    // Custody chain: complete, ordered, tamper-evident.
    const chainRows = orderCustodyChain(await db.select().from(custodyEvents));
    expect(chainRows.map((e) => e.type)).toEqual([
      'created',
      'funded', // origin bond
      'hub_checkin',
      'leg_accepted',
      'funded', // leg 1
      'hub_checkout',
      'hub_checkin_intermediate',
      'claim_requested',
      'funded', // claim (two holds)
      'recipient_claimed',
    ]);
    const verification = verifyCustodyChain(
      chainRows.map((e) => ({
        shipmentId: e.shipmentId,
        type: e.type,
        actorUserId: e.actorUserId,
        legId: e.legId,
        hubStayId: e.hubStayId,
        payload: e.payload as Record<string, unknown>,
        createdAt: e.createdAt.toISOString(),
        prevEventHash: e.prevEventHash,
        hash: e.hash,
      })),
    );
    expect(verification).toEqual({ valid: true });

    // Ledger ↔ coordinator keys collapsed: one held entry per payment, ever.
    const entries = await db.select().from(journalEntries);
    for (const cp of cps) {
      expect(entries.filter((e) => e.idempotencyKey === `cp:${cp.id}:held`)).toHaveLength(1);
    }
    // 6 payments × (held + settled|refunded) + 2 instant hub fees = 14.
    expect(entries).toHaveLength(14);

    // Zero custody, structurally (invariant 1): only user wallets and this
    // shipment's commitment bucket exist, and the coordinator asked only for
    // actual counterparties' wallets — Rita's included, platform's never.
    const personas = [world.marco, world.luca, world.anna, world.mario, world.carla, world.bruno, world.rita];
    const userIds = new Set(personas.map((p) => p.id));
    for (const account of await db.select().from(accounts)) {
      if (account.ownerType === 'user') {
        expect(account.kind).toBe('external_wallet');
        expect(userIds.has(account.ownerId)).toBe(true);
      } else {
        expect(account.ownerType).toBe('shipment');
        expect(account.kind).toBe('commitment');
        expect(account.ownerId).toBe(id);
      }
    }
    for (const resolved of world.resolvedWalletUsers) {
      expect(userIds.has(resolved)).toBe(true);
    }

    // Notifications: tracking (with the token), intermediate stop ×2,
    // delivered to the sender. Never a parcel_arrived: B was never reached.
    const outbox = await db.select().from(emailOutbox);
    expect(outbox.map((r) => r.template).sort()).toEqual([
      'parcel_at_intermediate_hub',
      'parcel_at_intermediate_hub',
      'parcel_delivered',
      'parcel_tracking',
    ]);
    const dispatched = await dispatchEmailOutbox({
      db,
      sendMail: async (mail) => {
        world.sentEmails.push(mail);
      },
      now: () => new Date(clock.nowMs),
    });
    expect(dispatched).toEqual({ sent: 4, failed: 0 });
    expect(world.sentEmails.find((m) => m.subject.includes('tracking'))?.text).toContain(claimToken);

    // Nightly reconciliation (invariant 6): nothing to report.
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('claim at the ORIGIN hub: Rita collects the whole pool + Π_v, Mario only Π_h — no fee', async () => {
    const world = await createLifecycleWorld();
    const { api, clock } = world;
    const { id, qrToken } = await createShipmentAtHub(world);
    const claimToken = await lastClaimToken(world);

    const claimRes = await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    const claim = claimRes.json() as { claimPaymentMsat: string; hubBonusMsat: string };
    expect(claim.claimPaymentMsat).toBe(CLAIM_AT_ORIGIN.toString()); // 4.85 €
    expect(claim.hubBonusMsat).toBe(HUB_BONUS.toString()); // 0.15 €

    clock.advanceMinutes(1);
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([id]);
    await api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.mario.cookie,
      body: { qrToken, claimToken },
      expect: 200,
    });

    // The origin hub gets NO fee from a claim (documented consequence of
    // ADR-016): the whole compensation for its handover work is Π_h.
    expect(world.balance(world.rita)).toBe(INITIAL_BALANCE_MSAT + CLAIM_AT_ORIGIN);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + HUB_BONUS);
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - 8_000_000n); // 5.00 € exactly
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('claim with Π_v already consumed (arrival + reroute + boost): pool residuo + fresh Π_h only', async () => {
    const world = await createLifecycleWorld();
    const { api, clock } = world;
    // Reach AWAITING_PICKUP at B: Anna's arrival consumed Π_v.
    const { id, qrToken } = await carryToC(world);
    const trip2 = await declareTrip(world, world.anna, 30, 105);
    await api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: trip2, toHubId: world.hubB },
      expect: 201,
    });
    clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    await doubleConfirmCheckout(world, id, qrToken, world.carla, world.anna);
    clock.advanceMinutes(30);
    await api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.bruno.cookie,
      body: { qrToken, photoSha256: [sha('checkin-b')], integrityConfirmed: true },
      expect: 200,
    });

    // No claim from AWAITING_PICKUP: the OTP pickup exists there (ADR-016).
    const claimToken = await lastClaimToken(world);
    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 409,
    });

    // Reroute B→C (fresh segment, pool 0) + boost: 2.00 € → work 1.80 €,
    // hub quota accrues to 0.15 + 0.06 = 0.21 €; the carrier quota accrual
    // stays with Marco (consumed by the first arrival).
    await api({
      method: 'POST',
      url: `/shipments/${id}/reroute`,
      cookie: world.marco.cookie,
      body: { newDestHubId: world.hubC },
      expect: 200,
    });
    await api({
      method: 'POST',
      url: `/shipments/${id}/boost`,
      cookie: world.marco.cookie,
      body: { amountMsat: '2000000', idempotencyKey: 'boost-before-claim' },
      expect: 200,
    });

    const claimRes = await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    const claim = claimRes.json() as { claimPaymentMsat: string; hubBonusMsat: string };
    expect(claim.claimPaymentMsat).toBe('1800000'); // boost work only, Π_v consumed
    expect(claim.hubBonusMsat).toBe('300000'); // 0.15 (offer) + 0.06 (boost)

    clock.advanceMinutes(1);
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([id]);
    await api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.bruno.cookie,
      body: { qrToken, claimToken },
      expect: 200,
    });

    expect(world.balance(world.rita)).toBe(INITIAL_BALANCE_MSAT + 1_800_000n);
    // Bruno: arrival fee of leg 2 (0.27 €) + fresh Π_h (0.21 €).
    expect(world.balance(world.bruno)).toBe(INITIAL_BALANCE_MSAT + 432_000n + 300_000n);
    // Conservation: Marco paid both legs (leg 2 hold includes Π_v), the claim
    // and Π_h; the boost's unconsumed carrier accrual (0.14 €) stays with him.
    expect(world.balance(world.marco)).toBe(
      INITIAL_BALANCE_MSAT - LEG1_GROSS - (4_320_000n + CARRIER_BONUS) - 1_800_000n - 300_000n,
    );
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('claim funding expiry: holds dissolve, the parcel returns to the board', async () => {
    const world = await createLifecycleWorld();
    const { api, clock } = world;
    const { id } = await createShipmentAtHub(world);
    const claimToken = await lastClaimToken(world);

    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    // Funds are in flight toward the holds, but nothing books yet...
    expect(world.balance(world.marco)).toBe(
      INITIAL_BALANCE_MSAT - CLAIM_AT_ORIGIN - HUB_BONUS,
    );

    // ...and the window closes: the timer dissolves everything.
    clock.advanceMinutes(61);
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);
    expect(await fireDueTimers(world.app.lifecycle)).toEqual({ fired: 0, stale: 0 });

    expect(await shipmentStatus(world, id)).toBe('at_hub');
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.rita)).toBe(INITIAL_BALANCE_MSAT);
    const [claimRow] = await world.db.select().from(shipmentClaims);
    expect(claimRow!.status).toBe('expired');
    // A late pump finds nothing pending: the expiry is final.
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([]);
    // The parcel is back on the board for carriers.
    const trip = await declareTrip(world, world.luca, -5, 50);
    const board = await api({
      method: 'GET',
      url: `/trips/${trip}/board`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    expect((board.json() as { cards: unknown[] }).cards).toHaveLength(1);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('storage expiry from CLAIMED: FORFEITED, the held claim commitments return to the sender', async () => {
    const world = await createLifecycleWorld();
    const { api, clock } = world;
    const { id } = await createShipmentAtHub(world);
    const claimToken = await lastClaimToken(world);

    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    clock.advanceMinutes(1);
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([id]);
    expect(await shipmentStatus(world, id)).toBe('claimed');

    // Storage never pauses for a claim (ADR-016): the sender chose 72 h.
    clock.advanceHours(73);
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    expect(await shipmentStatus(world, id)).toBe('forfeited');
    // Everyone whole again: the forfeited parcel compensates the hub (ToS).
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.rita)).toBe(INITIAL_BALANCE_MSAT);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT);
    const [claimRow] = await world.db.select().from(shipmentClaims);
    expect(claimRow!.status).toBe('expired');
    expect(await world.commitmentBalance(id)).toBe(0n);
    expect(await world.db.select().from(shipmentTimers)).toHaveLength(0);
    expect((await reconcile(world.app.lifecycle)).discrepancies).toEqual([]);
  }, 30_000);

  it('a recipient-changing reroute rotates the claim token: the old one is dead', async () => {
    const world = await createLifecycleWorld();
    const { api } = world;
    const { id } = await createShipmentAtHub(world);
    const oldToken = await lastClaimToken(world);

    await api({
      method: 'POST',
      url: `/shipments/${id}/reroute`,
      cookie: world.marco.cookie,
      body: { newRecipientEmail: 'nuova@test.local' },
      expect: 200,
    });
    // The fresh tracking mail went to the NEW recipient with a NEW token.
    const trackingMails = (await world.db.select().from(emailOutbox)).filter(
      (r) => r.template === 'parcel_tracking',
    );
    expect(trackingMails).toHaveLength(2);
    expect(trackingMails.at(-1)!.to).toBe('nuova@test.local');
    const newToken = (trackingMails.at(-1)!.payload as { claimToken: string }).claimToken;
    expect(newToken).not.toBe(oldToken);

    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken: oldToken },
      expect: 422,
    });
    // The token is a bearer credential (ADR-016): whoever holds the CURRENT
    // one — here Rita, handed it by the new recipient — can claim.
    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken: newToken },
      expect: 201,
    });
  }, 30_000);

  it('disjoint roles: the sender and the pickup-hub owner cannot claim', async () => {
    const world = await createLifecycleWorld();
    const { api } = world;
    const { id } = await createShipmentAtHub(world);
    const claimToken = await lastClaimToken(world);

    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.marco.cookie, // the sender
      body: { claimToken },
      expect: 422,
    });
    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.mario.cookie, // the custodian hub's owner
      body: { claimToken },
      expect: 422,
    });
    // A wrong token is rejected before anything else moves.
    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken: 'not-the-token' },
      expect: 422,
    });
  }, 30_000);

  it('retries move nothing twice: pickup after DELIVERED is refused, balances stand', async () => {
    const world = await createLifecycleWorld();
    const { api, clock } = world;
    const { id, qrToken } = await createShipmentAtHub(world);
    const claimToken = await lastClaimToken(world);

    await api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });
    clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);
    await api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.mario.cookie,
      body: { qrToken, claimToken },
      expect: 200,
    });
    const ritaAfter = world.balance(world.rita);
    const entriesAfter = (await world.db.select().from(journalEntries)).length;

    // DELIVERED released the stay: the retry finds no custodian hub (403)
    // before the machine would say "terminal" — either way, nothing moves.
    await api({
      method: 'POST',
      url: `/shipments/${id}/claimed-pickup`,
      cookie: world.mario.cookie,
      body: { qrToken, claimToken },
      expect: 403,
    });
    // A late pump and a late sweep are no-ops too.
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([]);
    await fireDueTimers(world.app.lifecycle);
    expect(world.balance(world.rita)).toBe(ritaAfter);
    expect((await world.db.select().from(journalEntries)).length).toBe(entriesAfter);
    // Exactly one settled entry per settled payment, ever.
    const cps = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.shipmentId, id));
    for (const cp of cps.filter((p) => p.state === 'settled')) {
      const settled = await world.db
        .select()
        .from(journalEntries)
        .where(and(eq(journalEntries.idempotencyKey, `cp:${cp.id}:settled`)));
      expect(settled).toHaveLength(1);
    }
  }, 30_000);
});
