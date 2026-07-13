// The canonical flow of CLAUDE.md, end to end over HTTP on pglite + the fake
// Lightning network: Marco ships pens A→B (100 km, 5 € offer, 15 € bond,
// hubs at 10%), Luca carries A→C (40 km), Anna finishes C→B and earns the
// carrier share of the finalization bonus, hub B earns its share at the
// recipient's pickup (ADR-014). Every euro figure of ECONOMICS.md §5-bis is
// asserted exactly, in msat, on REAL wallet balances — the fake network only
// moves funds on settle/cancel with the true preimage, so these numbers
// cannot lie.

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  accounts,
  conditionalPayments,
  custodyEvents,
  emailOutbox,
  journalEntries,
  shipments,
  shipmentTimers,
} from '@mercurio/db';
import { verifyCustodyChain } from '@mercurio/core';
import { pumpWalletEvents } from './pump';
import { dispatchEmailOutbox } from './outbox';
import { reconcile } from './reconcile';
import { orderCustodyChain } from './context';
import {
  BOND_MSAT,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  doubleConfirmCheckout,
  INITIAL_BALANCE_MSAT,
  sha,
} from './test-world';

// ECONOMICS.md §5-bis, at 1600 sats/€ (all msat):
const LEG1_GROSS = 2_880_000n; // 1.80 € — 40/100 of the 4.50 € work pool
const LEG1_FEE = 288_000n; // 0.18 € per adjacent hub
const LUCA_NET = 2_304_000n; // 1.44 €
const LEG2_GROSS = 4_320_000n; // 2.70 €
const LEG2_FEE = 432_000n; // 0.27 €
const CARRIER_BONUS = 560_000n; // Π_v 0.35 €
const HUB_BONUS = 240_000n; // Π_h 0.15 €
const ANNA_NET = 4_016_000n; // 2.51 €
const HUB_B_TOTAL = 672_000n; // 0.42 €
const HUB_C_TOTAL = 720_000n; // 0.45 € (arrival 0.18 + departure 0.27)

describe('canonical shipment lifecycle (A→C→B with finalization bonus)', () => {
  it('delivers, pays everyone exactly, and leaves the commitment at zero', async () => {
    const world = await createLifecycleWorld();
    const { api, clock, db } = world;

    // --- create + drop-off at hub A --------------------------------------
    const { id, qrToken } = await createShipmentAtHub(world);
    // Mario's custody bond is already in flight (hold held, funds committed).
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);
    expect(await world.commitmentBalance(id)).toBe(BOND_MSAT);

    // --- Luca declares his real trip and consults the board ---------------
    const lucaTrip = await declareTrip(world, world.luca, -5, 50);
    const board1 = await api({
      method: 'GET',
      url: `/trips/${lucaTrip}/board`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    const cards = (board1.json() as { cards: Record<string, unknown>[] }).cards;
    expect(cards).toHaveLength(1);
    const card = cards[0]! as {
      shipmentId: string;
      isMatch: boolean;
      bestDropHub: { hubId: string; netMsat: string; finalizationBonusMsat: string };
    };
    expect(card.shipmentId).toBe(id);
    expect(card.isMatch).toBe(true);
    // Best drop for a trip ending near C: hub C, net frozen at 1.44 €.
    expect(card.bestDropHub.hubId).toBe(world.hubC);
    expect(card.bestDropHub.netMsat).toBe(LUCA_NET.toString());
    expect(card.bestDropHub.finalizationBonusMsat).toBe('0');

    // --- leg 1: accept, fund (wallet pump), pickup, deliver to C ----------
    const leg1 = await api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId: lucaTrip, toHubId: world.hubC },
      expect: 201,
    });
    const leg1Body = leg1.json() as { pricing: Record<string, string> };
    expect(leg1Body.pricing).toEqual({
      grossMsat: LEG1_GROSS.toString(),
      depHubFeeMsat: LEG1_FEE.toString(),
      arrHubFeeMsat: LEG1_FEE.toString(),
      netMsat: LUCA_NET.toString(),
      finalizationBonusMsat: '0',
    });

    clock.advanceMinutes(1);
    const pump1 = await pumpWalletEvents(world.app.lifecycle);
    expect(pump1.funded).toEqual([id]);
    // Booked: sender's leg payment, Luca's bond and hub C's bond in flight.
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - LEG1_GROSS);
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);

    clock.advanceMinutes(10);
    await doubleConfirmCheckout(world, id, qrToken, world.mario, world.luca);
    // Departure fee paid on the spot; Mario's bond released: he nets 0.18 €.
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE);

    clock.advanceMinutes(60);
    await api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.carla.cookie,
      body: { qrToken, photoSha256: [sha('checkin-c')], integrityConfirmed: true },
      expect: 200,
    });
    // Luca collected the gross (preimage revealed), paid both fees on the
    // spot, and his bond came back: exactly 1.44 € (the canonical figure).
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT + LUCA_NET);

    // --- leg 2: Anna's trip, final leg with the bonus ---------------------
    const annaTrip = await declareTrip(world, world.anna, 30, 105);
    const board2 = await api({
      method: 'GET',
      url: `/trips/${annaTrip}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    const card2 = (board2.json() as { cards: Record<string, unknown>[] }).cards[0]! as {
      bestDropHub: { hubId: string; netMsat: string; finalizationBonusMsat: string };
    };
    // Direct delivery to B: the net INCLUDES Π_v, exposed as its own line.
    expect(card2.bestDropHub.hubId).toBe(world.hubB);
    expect(card2.bestDropHub.netMsat).toBe((LEG2_GROSS - 2n * LEG2_FEE + CARRIER_BONUS).toString());
    expect(card2.bestDropHub.finalizationBonusMsat).toBe(CARRIER_BONUS.toString());

    const leg2 = await api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: annaTrip, toHubId: world.hubB },
      expect: 201,
    });
    const leg2Body = leg2.json() as {
      pricing: Record<string, string>;
      finalizationHubBonusMsat: string;
    };
    expect(leg2Body.pricing.grossMsat).toBe(LEG2_GROSS.toString());
    expect(leg2Body.pricing.finalizationBonusMsat).toBe(CARRIER_BONUS.toString());
    expect(leg2Body.finalizationHubBonusMsat).toBe(HUB_BONUS.toString());

    clock.advanceMinutes(1);
    const pump2 = await pumpWalletEvents(world.app.lifecycle);
    expect(pump2.funded).toEqual([id]);
    // Four holds now bind the final leg (ESCROW §3 + ADR-014): the sender
    // pays gross+Π_v and Π_h; carrier and hub B pay their bonds.
    expect(world.balance(world.marco)).toBe(
      INITIAL_BALANCE_MSAT - LEG1_GROSS - LEG2_GROSS - CARRIER_BONUS - HUB_BONUS,
    );

    clock.advanceMinutes(10);
    await doubleConfirmCheckout(world, id, qrToken, world.carla, world.anna);
    // Hub C earned both adjacent fees (0.18 + 0.27) and its bond is back.
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT + HUB_C_TOTAL);

    clock.advanceMinutes(90);
    await api({
      method: 'POST',
      url: `/shipments/${id}/checkin`,
      cookie: world.bruno.cookie,
      body: { qrToken, photoSha256: [sha('checkin-b')], integrityConfirmed: true },
      expect: 200,
    });
    // Anna nets 2.51 €: gross + Π_v − the two fees; her bond is back.
    expect(world.balance(world.anna)).toBe(INITIAL_BALANCE_MSAT + ANNA_NET);

    // --- recipient pickup with the OTP from the arrival email -------------
    const outboxRows = await db.select().from(emailOutbox);
    const arrivalMail = outboxRows.find((r) => r.template === 'parcel_arrived');
    expect(arrivalMail?.to).toBe('destinataria@test.local');
    const otp = (arrivalMail!.payload as { otp: string }).otp;
    expect(otp).toMatch(/^\d{6}$/);

    await api({
      method: 'POST',
      url: `/shipments/${id}/pickup`,
      cookie: world.bruno.cookie,
      body: { qrToken, otp },
      expect: 200,
    });

    // --- the money: every figure of ECONOMICS.md §5-bis, on real wallets --
    expect(world.balance(world.marco)).toBe(INITIAL_BALANCE_MSAT - 8_000_000n); // 5.00 €
    expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT + LUCA_NET); // +1.44 €
    expect(world.balance(world.anna)).toBe(INITIAL_BALANCE_MSAT + ANNA_NET); // +2.51 €
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT + LEG1_FEE); // +0.18 €
    expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT + HUB_C_TOTAL); // +0.45 €
    expect(world.balance(world.bruno)).toBe(INITIAL_BALANCE_MSAT + HUB_B_TOTAL); // +0.42 €

    // --- aggregate closed clean -------------------------------------------
    const [row] = await db.select().from(shipments).where(eq(shipments.id, id));
    expect(row!.status).toBe('delivered');
    expect(await world.commitmentBalance(id)).toBe(0n); // invariant 2
    const cps = await db.select().from(conditionalPayments);
    expect(cps).toHaveLength(8); // 3 payments settled + 5 bonds refunded
    expect(cps.filter((p) => p.state === 'settled')).toHaveLength(3);
    expect(cps.filter((p) => p.state === 'cancelled')).toHaveLength(5);
    expect(await db.select().from(shipmentTimers)).toHaveLength(0);

    // Custody chain: complete, ordered, tamper-evident (ADR-012).
    const chainRows = orderCustodyChain(await db.select().from(custodyEvents));
    expect(chainRows.map((e) => e.type)).toEqual([
      'created',
      'funded', // origin bond
      'hub_checkin',
      'leg_accepted',
      'funded', // leg 1
      'hub_checkout',
      'hub_checkin_intermediate',
      'leg_accepted',
      'funded', // leg 2 (four holds)
      'hub_checkout',
      'arrived_destination',
      'recipient_pickup',
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
    // 8 payments × (held + settled|refunded) + 4 instant hub fees = 20.
    expect(entries).toHaveLength(20);

    // Zero custody, structurally (invariant 1): every ledger account belongs
    // to a user's external wallet or a shipment's commitment bucket, and the
    // coordinator only ever asked for the wallets of actual counterparties.
    const accountRows = await db.select().from(accounts);
    const userIds = new Set(
      [world.marco, world.luca, world.anna, world.mario, world.carla, world.bruno].map(
        (p) => p.id,
      ),
    );
    for (const account of accountRows) {
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

    // Notifications: tracking with the claim token (ADR-016), intermediate
    // stop (×2), arrival with OTP, delivered.
    const outbox = await db.select().from(emailOutbox);
    expect(outbox.map((r) => r.template).sort()).toEqual([
      'parcel_arrived',
      'parcel_at_intermediate_hub',
      'parcel_at_intermediate_hub',
      'parcel_delivered',
      'parcel_tracking',
    ]);
    const trackingMail = outbox.find((r) => r.template === 'parcel_tracking');
    expect(trackingMail?.to).toBe('destinataria@test.local');
    expect((trackingMail!.payload as { claimToken: string }).claimToken).toMatch(/./);
    const dispatched = await dispatchEmailOutbox({
      db,
      sendMail: async (mail) => {
        world.sentEmails.push(mail);
      },
      now: () => new Date(clock.nowMs),
    });
    expect(dispatched).toEqual({ sent: 5, failed: 0 });
    expect(world.sentEmails.find((m) => m.subject.includes('ritiralo'))?.text).toContain(otp);

    // Nightly reconciliation (invariant 6): nothing to report.
    const report = await reconcile(world.app.lifecycle);
    expect(report.discrepancies).toEqual([]);
  }, 30_000);
});
