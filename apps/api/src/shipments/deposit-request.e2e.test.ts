// ADR-029 end-to-end: the deposit request on a MANUAL arrival hub, over the
// real HTTP surface with fake wallets. The money rigor the ADR demands:
//
//   - leg_request moves NOTHING: no conditional payment, no journal entry,
//     no wallet touched — only a leg row in 'requested', a response timer and
//     the hub's notification email.
//   - deposit_accept creates exactly the holds the pre-ADR-029 leg_accept
//     created (asserted bit-per-bit at the machine level; here on real rows).
//   - reject / timeout / cancel dissolve the request at ZERO cost and put the
//     shipment back on the board.
//   - a pending request is board-exclusive (decisione C).

import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  conditionalPayments,
  emailOutbox,
  hubs,
  journalEntries,
  legs,
  rejections,
  shipments,
  shipmentTimers,
} from '@mercurio/db';
import { pumpWalletEvents } from './pump.js';
import { fireDueTimers } from './timers.js';
import {
  BOND_MSAT,
  createLifecycleWorld,
  createShipmentAtHub,
  declareTrip,
  INITIAL_BALANCE_MSAT,
  type LifecycleWorld,
} from './test-world.js';

/** Make hub C manual: requests to it wait for Carla's answer (ADR-029). */
async function makeHubCManual(world: LifecycleWorld): Promise<void> {
  await world.db.update(hubs).set({ autoAccept: false }).where(eq(hubs.id, world.hubC));
}

/** Open the canonical request Luca → hub C and return the leg id. */
async function openRequest(world: LifecycleWorld, id: string): Promise<string> {
  const trip = await declareTrip(world, world.luca, -5, 50);
  const res = await world.api({
    method: 'POST',
    url: `/shipments/${id}/legs`,
    cookie: world.luca.cookie,
    body: { tripId: trip, toHubId: world.hubC },
    expect: 201,
  });
  const body = res.json() as {
    legId: string;
    status: string;
    requiresHubConfirmation: boolean;
    fundingDeadlineAt: string | null;
    responseDeadlineAt: string;
  };
  expect(body.status).toBe('requested');
  expect(body.requiresHubConfirmation).toBe(true);
  expect(body.fundingDeadlineAt).toBeNull();
  return body.legId;
}

async function shipmentStatus(world: LifecycleWorld, id: string): Promise<string> {
  const [row] = await world.db.select().from(shipments).where(eq(shipments.id, id));
  return row!.status;
}

/** The whole-request-phase invariant: the ONLY payment ever created so far is
 *  the origin hub bond, the ONLY journal entry its held recognition. */
async function expectZeroRequestMoney(world: LifecycleWorld): Promise<void> {
  const cps = await world.db.select().from(conditionalPayments);
  expect(cps).toHaveLength(1);
  expect(cps[0]!.purpose).toBe('custody_bond');
  expect(await world.db.select().from(journalEntries)).toHaveLength(1);
  expect(world.balance(world.luca)).toBe(INITIAL_BALANCE_MSAT);
  expect(world.balance(world.carla)).toBe(INITIAL_BALANCE_MSAT);
}

describe('deposit request on a manual arrival hub (ADR-029)', () => {
  it('leg_request: no money, off the board, hub notified and dashboard shows the request', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);

    // The board marks the manual hub before the request (ADR-029 §3).
    const boardTrip = await declareTrip(world, world.anna, -5, 45);
    const before = await world.api({
      method: 'GET',
      url: `/trips/${boardTrip}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    const cards = (before.json() as {
      cards: {
        bestDropHub: { hubId: string; requiresConfirmation: boolean };
        alternatives: { hubId: string; requiresConfirmation: boolean }[];
      }[];
    }).cards;
    expect(cards).toHaveLength(1);
    const options = [cards[0]!.bestDropHub, ...cards[0]!.alternatives];
    // (Hub B sits 110 km off this trip: outside dev_max, so not proposed —
    // the unmarked auto-accept case is covered by the matching unit tests.)
    expect(options.find((o) => o.hubId === world.hubC)?.requiresConfirmation).toBe(true);

    const legId = await openRequest(world, id);
    await expectZeroRequestMoney(world);
    expect(await shipmentStatus(world, id)).toBe('at_hub'); // state unchanged

    // The leg row is 'requested' with the response deadline, no payment ids.
    const [legRow] = await world.db.select().from(legs).where(eq(legs.id, legId));
    expect(legRow!.status).toBe('requested');
    expect(legRow!.responseDeadlineAt).not.toBeNull();
    expect(legRow!.fundingDeadlineAt).toBeNull();
    expect(legRow!.paymentConditionalPaymentId).toBeNull();

    // Response timer armed alongside the storage timer.
    const timers = await world.db.select().from(shipmentTimers);
    expect(timers.map((t) => t.kind).sort()).toEqual(['deposit_response', 'storage']);

    // Board-exclusive: the shipment left the board for other carriers.
    const after = await world.api({
      method: 'GET',
      url: `/trips/${boardTrip}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    expect((after.json() as { cards: unknown[] }).cards).toEqual([]);

    // The hub is notified with the ADR-028 template at its account email
    // (hub C has no venue contactEmail in the test world).
    const outbox = await world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'hub_deposit_request'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(world.carla.email);

    // Carla's dashboard: the request on top, with the EXACT frozen earning
    // (the leg's arrival fee) and the response deadline (punto 9).
    const dash = await world.api({
      method: 'GET',
      url: '/hubs/mine/requests',
      cookie: world.carla.cookie,
      expect: 200,
    });
    const { depositRequests } = dash.json() as {
      depositRequests: {
        legId: string;
        responseDeadlineAt: string | null;
        projectedEarning: { kind: string; msat: string };
      }[];
    };
    expect(depositRequests).toHaveLength(1);
    expect(depositRequests[0]!.legId).toBe(legId);
    expect(depositRequests[0]!.responseDeadlineAt).not.toBeNull();
    expect(depositRequests[0]!.projectedEarning).toEqual({
      kind: 'exact',
      msat: legRow!.arrHubFeeMsat.toString(),
    });
  }, 30_000);

  it('deposit_accept: the holds appear exactly as a leg_accept created them, then funding books', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);
    const legId = await openRequest(world, id);

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-accept`,
      cookie: world.carla.cookie,
      expect: 200,
    });

    const [legRow] = await world.db.select().from(legs).where(eq(legs.id, legId));
    expect(legRow!.status).toBe('pending_funding');
    expect(legRow!.fundingDeadlineAt).not.toBeNull();

    // The three holds of ESCROW.md §3, exactly (no final leg here: no Π_h).
    const cps = await world.db
      .select()
      .from(conditionalPayments)
      .where(eq(conditionalPayments.shipmentId, id));
    const held = cps.filter((p) => p.refType === 'leg' || p.refType === 'hub_stay');
    expect(held.map((p) => p.purpose).sort()).toEqual([
      'custody_bond', // origin hub (pre-existing)
      'custody_bond', // carrier
      'custody_bond', // arrival hub
      'leg_payment',
    ]);
    const carrierBond = cps.find((p) => p.payerId === world.luca.id);
    expect(carrierBond?.amountMsat).toBe(BOND_MSAT);
    const arrivalBond = cps.find((p) => p.payerId === world.carla.id);
    expect(arrivalBond?.amountMsat).toBe(BOND_MSAT);
    const payment = cps.find((p) => p.purpose === 'leg_payment');
    expect(payment?.payerId).toBe(world.marco.id);
    expect(payment?.payeeId).toBe(world.luca.id);
    expect(payment?.amountMsat).toBe(legRow!.grossMsat);

    // The response timer is gone; funding + storage remain armed.
    const timers = await world.db.select().from(shipmentTimers);
    expect(timers.map((t) => t.kind).sort()).toEqual(['leg_funding', 'storage']);

    // While the leg waits for funding, Carla's reserved stay already shows
    // the EXACT frozen arrival fee — not an origin-style estimate over the
    // whole route (review C2: the fee froze at leg_request, deposit_accept
    // only reserved the shelf).
    const dash = await world.api({
      method: 'GET',
      url: '/hubs/mine/requests',
      cookie: world.carla.cookie,
      expect: 200,
    });
    const { stays } = dash.json() as {
      stays: { shipmentId: string; status: string; projectedEarning: { kind: string; msat: string } }[];
    };
    const reserved = stays.find((s) => s.shipmentId === id);
    expect(reserved?.status).toBe('reserved');
    expect(reserved?.projectedEarning).toEqual({
      kind: 'exact',
      msat: legRow!.arrHubFeeMsat.toString(),
    });

    // Wallet events fund the leg exactly as in the auto-accept flow.
    expect((await pumpWalletEvents(world.app.lifecycle)).funded).toEqual([id]);
    expect(await shipmentStatus(world, id)).toBe('leg_booked');
  }, 30_000);

  it('deposit_reject: zero money, rejections row, carrier email, back on the board', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);
    const legId = await openRequest(world, id);

    // Only the arrival hub owner may answer.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-reject`,
      cookie: world.bruno.cookie,
      body: { reason: 'not my request' },
      expect: 403,
    });

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-reject`,
      cookie: world.carla.cookie,
      body: { reason: 'scaffale pieno questa settimana' },
      expect: 200,
    });

    await expectZeroRequestMoney(world);
    const [legRow] = await world.db.select().from(legs).where(eq(legs.id, legId));
    expect(legRow!.status).toBe('expired');
    expect(await shipmentStatus(world, id)).toBe('at_hub');

    // Documentation, not a judgment (ADR-012): the rejections row.
    const rows = await world.db.select().from(rejections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      legId,
      rejectedBy: world.carla.id,
      stage: 'deposit_request',
      reason: 'scaffale pieno questa settimana',
    });

    // The carrier is notified and the shipment is back on the board.
    const outbox = await world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'deposit_request_rejected'));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe(world.luca.email);
    const trip = await declareTrip(world, world.anna, -5, 45);
    const board = await world.api({
      method: 'GET',
      url: `/trips/${trip}/board`,
      cookie: world.anna.cookie,
      expect: 200,
    });
    expect((board.json() as { cards: unknown[] }).cards).toHaveLength(1);
    // Only the storage timer survives.
    expect((await world.db.select().from(shipmentTimers)).map((t) => t.kind)).toEqual(['storage']);
  }, 30_000);

  it('deposit_request_expired: the sweep dissolves the silent request at zero cost', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);
    const legId = await openRequest(world, id);

    world.clock.advanceMinutes(31);
    const swept = await fireDueTimers(world.app.lifecycle);
    expect(swept.fired).toBe(1);

    await expectZeroRequestMoney(world);
    const [legRow] = await world.db.select().from(legs).where(eq(legs.id, legId));
    expect(legRow!.status).toBe('expired');
    expect(await shipmentStatus(world, id)).toBe('at_hub');
    // The silence is documented against the hub, with the machine token.
    const rows = await world.db.select().from(rejections);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rejectedBy: world.carla.id,
      stage: 'deposit_request',
      reason: 'deposit_response_expired',
    });
    expect(
      await world.db
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.template, 'deposit_request_rejected')),
    ).toHaveLength(1);
    // The accept now lands on a dead request.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-accept`,
      cookie: world.carla.cookie,
      expect: 409,
    });
  }, 30_000);

  it('deposit_request_cancel: the carrier re-targets at zero cost, no rejections row', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);
    const legId = await openRequest(world, id);

    // Only the requesting carrier may withdraw.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-cancel`,
      cookie: world.anna.cookie,
      expect: 403,
    });
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs/${legId}/deposit-cancel`,
      cookie: world.luca.cookie,
      expect: 200,
    });

    await expectZeroRequestMoney(world);
    expect(await world.db.select().from(rejections)).toHaveLength(0);
    expect(await shipmentStatus(world, id)).toBe('at_hub');

    // Re-target immediately: a fresh request to the DESTINATION hub (auto)
    // books instantly — the pre-consent path.
    const trip = await declareTrip(world, world.luca, -5, 105);
    const res = await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId: trip, toHubId: world.hubB },
      expect: 201,
    });
    expect((res.json() as { status: string }).status).toBe('pending_funding');
  }, 30_000);

  it('a pending request is board-exclusive: boost, cancel and rival requests are rejected', async () => {
    const world = await createLifecycleWorld();
    await makeHubCManual(world);
    const { id } = await createShipmentAtHub(world);
    await openRequest(world, id);

    await world.api({
      method: 'POST',
      url: `/shipments/${id}/boost`,
      cookie: world.marco.cookie,
      body: { amountMsat: '1000000', idempotencyKey: 'boost-under-request' },
      expect: 422,
    });
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/cancel`,
      cookie: world.marco.cookie,
      expect: 422,
    });
    const rival = await declareTrip(world, world.anna, -5, 105);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.anna.cookie,
      body: { tripId: rival, toHubId: world.hubB },
      expect: 422,
    });
  }, 30_000);
});
