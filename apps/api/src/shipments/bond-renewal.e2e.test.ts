// Rolling hub-bond renewal (ADR-033) on real fake-Lightning balances: a
// long-storage shipment chains one hold per ≤7-day window with no net money
// movement, and a hub whose wallet cannot re-bond forfeits the stay early —
// the missed renewal IS a storage expiry (TOS §10), with the sender mailed.

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  conditionalPayments,
  custodyEvents,
  emailOutbox,
  hubs,
  hubStays,
  shipments,
  shipmentTimers,
} from '@mercurio/db';
import { fireDueTimers } from './timers.js';
import { reconcile } from './reconcile.js';
import {
  BOND_MSAT,
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  INITIAL_BALANCE_MSAT,
  sha,
  type LifecycleWorld,
} from './test-world.js';

/** The canonical shipment, but with a 14-day storage window: long enough to
 *  need two renewals of the origin bond (7-day windows, ADR-033). */
async function createLongStorageShipmentAtHub(world: LifecycleWorld): Promise<string> {
  // The fixture hubs cap storage at 7 days; raise them so the sender's
  // 14-day window is accepted (storageFitsHub).
  await world.db.update(hubs).set({ maxStorageDays: 30 });
  const created = await world.api({
    method: 'POST',
    url: '/shipments',
    cookie: world.marco.cookie,
    body: {
      ...CANONICAL_CREATE_BODY,
      originHubId: world.hubA,
      destHubId: world.hubB,
      maxStorageDays: 14,
    },
    expect: 201,
  });
  const { id, qrToken, originAccepted } = created.json() as {
    id: string;
    qrToken: string;
    originAccepted: boolean;
  };
  expect(originAccepted).toBe(true);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/origin-checkin`,
    cookie: world.mario.cookie,
    body: { qrToken, photoSha256: [sha('drop-off')] },
    expect: 200,
  });
  return id;
}

async function originStayRow(world: LifecycleWorld, shipmentId: string) {
  const [stay] = await world.db
    .select()
    .from(hubStays)
    .where(eq(hubStays.shipmentId, shipmentId));
  return stay!;
}

describe('rolling bond renewal (ADR-033)', () => {
  it('renews the origin bond twice across a 14-day storage: chained holds, zero net movement', async () => {
    const world = await createLifecycleWorld();
    const id = await createLongStorageShipmentAtHub(world);
    const t0 = world.clock.nowMs;

    const stayBefore = await originStayRow(world, id);
    const firstBondId = stayBefore.bondConditionalPaymentId!;
    expect(stayBefore.bondWindowEndsAt!.getTime()).toBe(t0 + 7 * 24 * 60 * 60 * 1000);
    // The renewal reminder is armed 24h before the window closes.
    const [timer] = await world.db
      .select()
      .from(shipmentTimers)
      .where(eq(shipmentTimers.kind, 'bond_renewal'));
    expect(timer!.refId).toBe(stayBefore.id);
    expect(timer!.fireAt.getTime()).toBe(t0 + 6 * 24 * 60 * 60 * 1000);

    // ---- first renewal: day 6 + 1h --------------------------------------
    world.clock.advanceHours(6 * 24 + 1);
    const sweep1 = await fireDueTimers(world.app.lifecycle);
    expect(sweep1.fired).toBe(1);

    const stayAfter1 = await originStayRow(world, id);
    expect(stayAfter1.bondConditionalPaymentId).not.toBe(firstBondId);
    expect(stayAfter1.bondWindowEndsAt!.getTime()).toBe(world.clock.nowMs + 7 * 24 * 60 * 60 * 1000);
    const [oldBond] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, firstBondId));
    const [newBond] = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.id, stayAfter1.bondConditionalPaymentId!));
    expect(oldBond!.state).toBe('cancelled');
    expect(newBond!.state).toBe('held');
    // Net zero for the hub: the new hold replaced the old one 1:1.
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);
    expect(await world.commitmentBalance(id)).toBe(BOND_MSAT);

    // ---- second renewal: day 12 + 1h (24h before window 2 closes) --------
    world.clock.advanceHours(6 * 24);
    const sweep2 = await fireDueTimers(world.app.lifecycle);
    expect(sweep2.fired).toBe(1);

    const stayAfter2 = await originStayRow(world, id);
    expect(stayAfter2.bondConditionalPaymentId).not.toBe(stayAfter1.bondConditionalPaymentId);
    expect(world.balance(world.mario)).toBe(INITIAL_BALANCE_MSAT - BOND_MSAT);

    // The chain documents every window (two bond_renewed events).
    const renewed = await world.db
      .select()
      .from(custodyEvents)
      .where(eq(custodyEvents.type, 'bond_renewed'));
    expect(renewed).toHaveLength(2);

    // Nothing to reconcile: the ledger mirrors the chained holds exactly.
    const report = await reconcile(world.app.lifecycle);
    expect(report.discrepancies).toEqual([]);
  }, 30_000);

  it('missed renewal while the parcel is stored: early forfeit, bond back, sender mailed', async () => {
    const world = await createLifecycleWorld();
    const id = await createLongStorageShipmentAtHub(world);

    // Drain Mario's wallet below the bond: the renewal dispatch will fail
    // ("insufficient balance") — the fake-network shape of a hub whose
    // wallet is offline or illiquid at renewal time.
    const drained = world.balance(world.mario) - 1_000_000n;
    const { bolt11 } = await world.luca.wallet.makeInvoice(drained, 'drain');
    await world.mario.wallet.payInvoice(bolt11, 0n);
    expect(world.balance(world.mario)).toBe(1_000_000n);

    // Day 6+1h: the renewal fires but cannot complete; the timer survives
    // for the next sweep (wallet trouble is retried, never swallowed).
    world.clock.advanceHours(6 * 24 + 1);
    const attempt = await fireDueTimers(world.app.lifecycle);
    expect(attempt.fired).toBe(0);
    expect(attempt.stale).toBe(0);
    expect(await world.db.select().from(shipmentTimers).then((t) => t.some((x) => x.kind === 'bond_renewal'))).toBe(true);

    // Past the window's end the missed renewal becomes an early storage
    // expiry (ADR-033 §3): FORFEITED, stay expired, bond refunded.
    world.clock.advanceHours(25);
    const sweep = await fireDueTimers(world.app.lifecycle);
    expect(sweep.fired).toBe(1);

    const [shipment] = await world.db.select().from(shipments).where(eq(shipments.id, id));
    expect(shipment!.status).toBe('forfeited');
    const stay = await originStayRow(world, id);
    expect(stay.status).toBe('expired');
    // The bond hold dissolved back to Mario: drained balance + bond.
    expect(world.balance(world.mario)).toBe(1_000_000n + BOND_MSAT);
    expect(await world.commitmentBalance(id)).toBe(0n);
    // No timers survive a terminal shipment.
    expect(await world.db.select().from(shipmentTimers)).toEqual([]);

    // The sender learns WHY: no 72/24h warnings preceded this end.
    const mails = await world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'hub_bond_lapsed'));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe(world.marco.email);
    expect((mails[0]!.payload as { phase?: string }).phase).toBe('storage');

    const report = await reconcile(world.app.lifecycle);
    expect(report.discrepancies).toEqual([]);
  }, 30_000);

  it('a short-storage stay never renews: the reminder dies as stale', async () => {
    const world = await createLifecycleWorld();
    // Canonical 3-day storage: the bond's 7-day window already covers it.
    await world.db.update(hubs).set({ maxStorageDays: 30 });
    const created = await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
      expect: 201,
    });
    const { id, qrToken } = created.json() as { id: string; qrToken: string };
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/origin-checkin`,
      cookie: world.mario.cookie,
      body: { qrToken, photoSha256: [sha('drop-off')] },
      expect: 200,
    });

    // Day 3+1h: storage expires first (the shipment forfeits normally) and
    // the renewal reminder — due only at day 6 — is consumed as stale when
    // it eventually fires against the terminal shipment.
    world.clock.advanceHours(3 * 24 + 1);
    await fireDueTimers(world.app.lifecycle);
    const [shipment] = await world.db.select().from(shipments).where(eq(shipments.id, id));
    expect(shipment!.status).toBe('forfeited');
    expect(await world.db.select().from(shipmentTimers)).toEqual([]);
  }, 30_000);
});
