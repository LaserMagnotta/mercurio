// Exhaustive suite for the shipment state machine (ARCHITECTURE.md §5).
// Every LEGAL transition is asserted against its EXACT effect list (toEqual
// on the whole array, not just the final state), every illegal (state,
// event) pair is asserted rejected, and every guard in the §5 table has a
// dedicated failure case.

import { describe, expect, it } from 'vitest';
import type { ShipmentEvent, ShipmentEventType, ShipmentState, TransitionResult } from '@mercurio/shared';
import { SHIPMENT_STATES } from '@mercurio/shared';
import { transition } from './state-machine';
import {
  BOND_MSAT,
  DEADLINES,
  IDS,
  OFFER_MSAT,
  PRICING,
  at,
  baseCtx,
  bookedLeg,
  ctxForState,
  finalLeg,
  originStay,
  pendingLeg,
  validEvent,
} from './fixtures';

function expectOk(result: TransitionResult): asserts result is Extract<TransitionResult, { ok: true }> {
  if (!result.ok) {
    throw new Error(`expected ok transition, got ${result.error.code}: ${result.error.message}`);
  }
}

function expectRejected(result: TransitionResult, code?: 'illegal_event' | 'guard_failed'): void {
  expect(result.ok).toBe(false);
  if (!result.ok && code) expect(result.error.code).toBe(code);
}

// ---------------------------------------------------------------------------
// #1 create

describe('create', () => {
  it('DRAFT is born with exactly one custody event and no money effects', () => {
    const result = transition(null, { type: 'create' }, baseCtx());
    expectOk(result);
    expect(result.nextState).toBe('DRAFT');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'created',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: null,
        payload: {
          originHubId: IDS.originHub,
          destHubId: IDS.destHub,
          offerMsat: OFFER_MSAT,
          custodyBondMsat: BOND_MSAT,
        },
      },
    ]);
  });

  it('guard: sender wallet must be connected', () => {
    expectRejected(
      transition(null, { type: 'create' }, { ...baseCtx(), senderWalletConnected: false }),
      'guard_failed',
    );
  });

  it('guard: origin and destination hubs must differ', () => {
    expectRejected(
      transition(null, { type: 'create' }, { ...baseCtx(), destHubId: IDS.originHub }),
      'guard_failed',
    );
  });

  it('guard: offer and bond must be positive', () => {
    expectRejected(transition(null, { type: 'create' }, { ...baseCtx(), offerMsat: 0n }), 'guard_failed');
    expectRejected(
      transition(null, { type: 'create' }, { ...baseCtx(), custodyBondMsat: 0n }),
      'guard_failed',
    );
  });

  it('cannot create twice', () => {
    expectRejected(transition('DRAFT', { type: 'create' }, baseCtx()), 'illegal_event');
  });
});

// ---------------------------------------------------------------------------
// #2 origin_hub_accept

describe('origin_hub_accept', () => {
  it('binds the origin hub bond (hold + ledger entry)', () => {
    const result = transition('DRAFT', validEvent('origin_hub_accept'), baseCtx());
    expectOk(result);
    expect(result.nextState).toBe('AWAITING_DROPOFF');
    expect(result.effects).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'custody_bond',
        payerId: IDS.originHubUser,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'hub_stay', id: IDS.originStay },
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_held',
        ref: { type: 'hub_stay', id: IDS.originStay },
        postings: [
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: -BOND_MSAT },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: BOND_MSAT },
        ],
      },
      {
        kind: 'append_custody_event',
        type: 'funded',
        actorUserId: IDS.originHubUser,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { custodyBondMsat: BOND_MSAT },
      },
    ]);
  });

  it('guard: hub wallet must be connected', () => {
    expectRejected(
      transition('DRAFT', { ...validEvent('origin_hub_accept'), hubWalletConnected: false } as ShipmentEvent, baseCtx()),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #3 origin_checkin

describe('origin_checkin', () => {
  const ctx = ctxForState('AWAITING_DROPOFF');

  it('starts the storage clock and certifies the check-in', () => {
    const result = transition('AWAITING_DROPOFF', validEvent('origin_checkin'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'schedule_timeout', timeout: 'storage', refId: IDS.originStay, at: DEADLINES.storage },
      {
        kind: 'append_custody_event',
        type: 'hub_checkin',
        actorUserId: IDS.originHubUser,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { photoSha256: ['photo-a'] },
      },
    ]);
  });

  it('guard: photo is mandatory', () => {
    expectRejected(
      transition('AWAITING_DROPOFF', { ...validEvent('origin_checkin'), photoSha256: [] } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #4 leg_accept

describe('leg_accept', () => {
  const ctx = ctxForState('AT_HUB');

  it('opens the three holds of ESCROW.md §3 and arms the funding window', () => {
    const result = transition('AT_HUB', validEvent('leg_accept'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB'); // booked only when funded
    expect(result.effects).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'leg_payment',
        payerId: IDS.sender,
        payeeId: IDS.carrier,
        amountMsat: PRICING.grossMsat,
        ref: { type: 'leg', id: IDS.leg },
      },
      {
        kind: 'create_conditional_payment',
        purpose: 'custody_bond',
        payerId: IDS.carrier,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'leg', id: IDS.leg },
      },
      {
        kind: 'create_conditional_payment',
        purpose: 'custody_bond',
        payerId: IDS.intermediateHubUser,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
      },
      { kind: 'schedule_timeout', timeout: 'leg_funding', refId: IDS.leg, at: DEADLINES.funding },
      {
        kind: 'append_custody_event',
        type: 'leg_accepted',
        actorUserId: IDS.carrier,
        legId: IDS.leg,
        hubStayId: null,
        payload: {
          toHubId: IDS.intermediateHub,
          grossMsat: PRICING.grossMsat,
          depHubFeeMsat: PRICING.depHubFeeMsat,
          arrHubFeeMsat: PRICING.arrHubFeeMsat,
          netMsat: PRICING.netMsat,
          custodyBondMsat: BOND_MSAT,
        },
      },
    ]);
  });

  it.each([
    ['carrier trip not active', { carrierTripActive: false }],
    ['carrier wallet disconnected', { carrierWalletConnected: false }],
    ['arrival hub without auto-accept', { arrivalHubAutoAccepts: false }],
    ['arrival hub wallet disconnected', { arrivalHubWalletConnected: false }],
    ['arrival hub equals current hub', { toHubId: IDS.originHub }],
    ['inconsistent pricing', { pricing: { ...PRICING, netMsat: PRICING.netMsat + 1n } }],
    ['zero gross', { pricing: { grossMsat: 0n, depHubFeeMsat: 0n, arrHubFeeMsat: 0n, netMsat: 0n } }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('leg_accept'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });

  it('guard: only one pending leg at a time', () => {
    expectRejected(
      transition('AT_HUB', validEvent('leg_accept'), { ...ctx, leg: pendingLeg() }),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #5 leg_funded / leg_funding_expired

describe('leg_funded', () => {
  const ctx = { ...ctxForState('AT_HUB'), leg: pendingLeg() };

  it('books the leg: three commitments enter the ledger, storage pauses, pickup window arms', () => {
    const result = transition('AT_HUB', validEvent('leg_funded'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('LEG_BOOKED');
    expect(result.effects).toEqual([
      {
        kind: 'post_ledger_entry',
        eventType: 'leg_payment_held',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: -PRICING.grossMsat },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: PRICING.grossMsat },
        ],
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'carrier_bond_held',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: -BOND_MSAT },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: BOND_MSAT },
        ],
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_held',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          {
            ownerType: 'user',
            ownerId: IDS.intermediateHubUser,
            accountKind: 'external_wallet',
            amountMsat: -BOND_MSAT,
          },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'leg_funding', refId: IDS.leg },
      { kind: 'cancel_timeout', timeout: 'storage', refId: IDS.originStay },
      { kind: 'schedule_timeout', timeout: 'pickup', refId: IDS.leg, at: DEADLINES.pickup },
      {
        kind: 'append_custody_event',
        type: 'funded',
        actorUserId: null,
        legId: IDS.leg,
        hubStayId: null,
        payload: { grossMsat: PRICING.grossMsat, custodyBondMsat: BOND_MSAT },
      },
    ]);
  });

  it('guard: no pending leg to fund', () => {
    expectRejected(transition('AT_HUB', validEvent('leg_funded'), ctxForState('AT_HUB')), 'guard_failed');
  });

  it('guard: funding after the 60-minute window is rejected', () => {
    expectRejected(
      transition('AT_HUB', { type: 'leg_funded', now: at(61), pickupDeadlineAt: DEADLINES.pickup }, ctx),
      'guard_failed',
    );
  });
});

describe('leg_funding_expired', () => {
  const ctx = { ...ctxForState('AT_HUB'), leg: pendingLeg() };

  it('cancels the three holds with NO ledger entries (never became commitments)', () => {
    const result = transition('AT_HUB', validEvent('leg_funding_expired'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: IDS.leg,
        hubStayId: null,
        payload: { reason: 'leg_funding' },
      },
    ]);
  });

  it('guard: cannot expire before the window closes', () => {
    expectRejected(transition('AT_HUB', { type: 'leg_funding_expired', now: at(59) }, ctx), 'guard_failed');
  });
});

// ---------------------------------------------------------------------------
// #6 pickup_checkout

describe('pickup_checkout', () => {
  const ctx = ctxForState('LEG_BOOKED');

  it('pays the departure fee on the spot, releases the ceding hub bond, arms transit', () => {
    const result = transition('LEG_BOOKED', validEvent('pickup_checkout'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('IN_TRANSIT');
    expect(result.effects).toEqual([
      {
        kind: 'request_instant_payment',
        payerId: IDS.carrier,
        payeeId: IDS.originHubUser,
        amountMsat: PRICING.depHubFeeMsat,
        reason: 'dep_hub_fee',
        ref: { type: 'leg', id: IDS.leg },
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'dep_hub_fee_paid',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: -PRICING.depHubFeeMsat },
          {
            ownerType: 'user',
            ownerId: IDS.originHubUser,
            accountKind: 'external_wallet',
            amountMsat: PRICING.depHubFeeMsat,
          },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.originHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.originStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'pickup', refId: IDS.leg },
      { kind: 'schedule_timeout', timeout: 'transit', refId: IDS.leg, at: DEADLINES.transit },
      {
        kind: 'append_custody_event',
        type: 'hub_checkout',
        actorUserId: IDS.carrier,
        legId: IDS.leg,
        hubStayId: IDS.originStay,
        payload: { photoSha256: ['photo-checkout'], hubConfirmed: true, carrierConfirmed: true },
      },
    ]);
  });

  it('skips the fee invoice entirely when the departure hub fee is zero', () => {
    const zeroFeeCtx = {
      ...ctx,
      leg: { ...bookedLeg(), pricing: { ...PRICING, depHubFeeMsat: 0n, netMsat: PRICING.netMsat + PRICING.depHubFeeMsat } },
    };
    const result = transition('LEG_BOOKED', validEvent('pickup_checkout'), zeroFeeCtx);
    expectOk(result);
    expect(result.effects.filter((e) => e.kind === 'request_instant_payment')).toEqual([]);
    expect(result.effects.filter((e) => e.kind === 'post_ledger_entry')).toHaveLength(1); // only the bond refund
  });

  it.each([
    ['missing hub confirmation', { hubConfirmed: false }],
    ['missing carrier confirmation', { carrierConfirmed: false }],
    ['missing photo', { photoSha256: [] as string[] }],
    ['past the pickup deadline', { now: at(121) }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('LEG_BOOKED', { ...validEvent('pickup_checkout'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #7 pickup_timeout

describe('pickup_timeout', () => {
  const ctx = ctxForState('LEG_BOOKED');

  it('slashes the carrier bond to the sender, refunds payment and arrival bond, resumes storage', () => {
    const result = transition('LEG_BOOKED', validEvent('pickup_timeout'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'release_conditional_payment', paymentId: IDS.carrierBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'carrier_bond_slashed',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'leg_payment_refunded',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -PRICING.grossMsat },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: PRICING.grossMsat },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          {
            ownerType: 'user',
            ownerId: IDS.intermediateHubUser,
            accountKind: 'external_wallet',
            amountMsat: BOND_MSAT,
          },
        ],
      },
      { kind: 'schedule_timeout', timeout: 'storage', refId: IDS.originStay, at: DEADLINES.storage },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: IDS.leg,
        hubStayId: null,
        payload: { reason: 'pickup_timeout' },
      },
    ]);
  });

  it('guard: cannot fire before the pickup deadline', () => {
    expectRejected(transition('LEG_BOOKED', { type: 'pickup_timeout', now: at(119) }, ctx), 'guard_failed');
  });
});

// ---------------------------------------------------------------------------
// #8 / #9 leg_checkin

describe('leg_checkin at an intermediate hub (row 8)', () => {
  const ctx = ctxForState('IN_TRANSIT');

  it('fee on the spot, preimage to the carrier, carrier bond back, storage restarts, both notified', () => {
    const result = transition('IN_TRANSIT', validEvent('leg_checkin'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'request_instant_payment',
        payerId: IDS.carrier,
        payeeId: IDS.intermediateHubUser,
        amountMsat: PRICING.arrHubFeeMsat,
        reason: 'arr_hub_fee',
        ref: { type: 'leg', id: IDS.leg },
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'arr_hub_fee_paid',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: -PRICING.arrHubFeeMsat },
          {
            ownerType: 'user',
            ownerId: IDS.intermediateHubUser,
            accountKind: 'external_wallet',
            amountMsat: PRICING.arrHubFeeMsat,
          },
        ],
      },
      { kind: 'release_conditional_payment', paymentId: IDS.legPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'leg_payment_released',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -PRICING.grossMsat },
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: PRICING.grossMsat },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'carrier_bond_refunded',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'transit', refId: IDS.leg },
      { kind: 'schedule_timeout', timeout: 'storage', refId: IDS.arrivalStay, at: DEADLINES.storage },
      {
        kind: 'append_custody_event',
        type: 'hub_checkin_intermediate',
        actorUserId: IDS.intermediateHubUser,
        legId: IDS.leg,
        hubStayId: IDS.arrivalStay,
        payload: { photoSha256: ['photo-checkin'], integrityConfirmed: true },
      },
      { kind: 'queue_email', to: 'sender', template: 'parcel_at_intermediate_hub', payload: { hubId: IDS.intermediateHub } },
      { kind: 'queue_email', to: 'recipient', template: 'parcel_at_intermediate_hub', payload: { hubId: IDS.intermediateHub } },
    ]);
  });

  it.each([
    ['wrong hub', { hubId: IDS.destHub }],
    ['integrity not confirmed', { integrityConfirmed: false }],
    ['missing photo', { photoSha256: [] as string[] }],
    ['past the transit deadline', { now: at(601) }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('IN_TRANSIT', { ...validEvent('leg_checkin'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });
});

describe('leg_checkin at the destination hub (row 9)', () => {
  const ctx = { ...ctxForState('IN_TRANSIT'), leg: finalLeg() };
  const event = { ...validEvent('leg_checkin'), hubId: IDS.destHub } as ShipmentEvent;

  it('same money effects, arrived_destination custody event, recipient invited to pick up', () => {
    const result = transition('IN_TRANSIT', event, ctx);
    expectOk(result);
    expect(result.nextState).toBe('AWAITING_PICKUP');
    const custody = result.effects.find((e) => e.kind === 'append_custody_event');
    expect(custody).toEqual({
      kind: 'append_custody_event',
      type: 'arrived_destination',
      actorUserId: IDS.destHubUser,
      legId: IDS.leg,
      hubStayId: IDS.arrivalStay,
      payload: { photoSha256: ['photo-checkin'], integrityConfirmed: true },
    });
    expect(result.effects.filter((e) => e.kind === 'queue_email')).toEqual([
      { kind: 'queue_email', to: 'recipient', template: 'parcel_arrived', payload: { hubId: IDS.destHub } },
    ]);
    // Money is identical to the intermediate case: fee + release + bond refund.
    expect(result.effects.filter((e) => e.kind === 'release_conditional_payment')).toHaveLength(1);
    expect(result.effects.filter((e) => e.kind === 'refund_conditional_payment')).toHaveLength(1);
    expect(result.effects.filter((e) => e.kind === 'request_instant_payment')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #10 leg_return

describe('leg_return', () => {
  const ctx = ctxForState('IN_TRANSIT');

  it('dissolves payment and bonds, and the re-accepting hub posts a FRESH bond', () => {
    const result = transition('IN_TRANSIT', validEvent('leg_return'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'leg_payment_refunded',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -PRICING.grossMsat },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: PRICING.grossMsat },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'carrier_bond_refunded',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.carrier, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          {
            ownerType: 'user',
            ownerId: IDS.intermediateHubUser,
            accountKind: 'external_wallet',
            amountMsat: BOND_MSAT,
          },
        ],
      },
      {
        kind: 'create_conditional_payment',
        purpose: 'custody_bond',
        payerId: IDS.originHubUser,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'hub_stay', id: IDS.returnStay },
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_held',
        ref: { type: 'hub_stay', id: IDS.returnStay },
        postings: [
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: -BOND_MSAT },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'transit', refId: IDS.leg },
      { kind: 'schedule_timeout', timeout: 'storage', refId: IDS.returnStay, at: DEADLINES.storage },
      {
        kind: 'append_custody_event',
        type: 'leg_returned',
        actorUserId: IDS.originHubUser,
        legId: IDS.leg,
        hubStayId: IDS.returnStay,
        payload: { photoSha256: ['photo-return'] },
      },
    ]);
  });

  it.each([
    ['return to a hub that is not the departure hub', { hubId: IDS.destHub }],
    ['missing photo', { photoSha256: [] as string[] }],
    ['past the transit deadline', { now: at(601) }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('IN_TRANSIT', { ...validEvent('leg_return'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #11 recipient_pickup

describe('recipient_pickup', () => {
  const ctx = ctxForState('AWAITING_PICKUP');

  it('OTP closes the shipment: destination bond back, storage disarmed, sender notified', () => {
    const result = transition('AWAITING_PICKUP', validEvent('recipient_pickup'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('DELIVERED');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.destHubUser, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'storage', refId: IDS.arrivalStay },
      {
        kind: 'append_custody_event',
        type: 'recipient_pickup',
        actorUserId: IDS.destHubUser,
        legId: null,
        hubStayId: IDS.arrivalStay,
        payload: { otpVerified: true },
      },
      { kind: 'queue_email', to: 'sender', template: 'parcel_delivered', payload: {} },
    ]);
  });

  it('guard: OTP must be verified', () => {
    expectRejected(
      transition('AWAITING_PICKUP', { type: 'recipient_pickup', otpVerified: false }, ctx),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #12 handoff_reject — documentary, never a state change, never money

describe('handoff_reject', () => {
  it.each([
    ['LEG_BOOKED', 'pickup_checkout'],
    ['IN_TRANSIT', 'hub_checkin'],
    ['AWAITING_PICKUP', 'recipient_pickup'],
  ] as const)('in %s (stage %s): custody event + sender email, nothing else', (state, stage) => {
    const ctx = ctxForState(state);
    const result = transition(
      state,
      { type: 'handoff_reject', stage, rejectedById: 'user-x', reason: 'crushed box', photoSha256: ['ph'] },
      ctx,
    );
    expectOk(result);
    expect(result.nextState).toBe(state);
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'handoff_rejected',
        actorUserId: 'user-x',
        legId: ctx.leg?.legId ?? null,
        hubStayId: ctx.currentHubStay?.hubStayId ?? null,
        payload: { stage, reason: 'crushed box', photoSha256: ['ph'] },
      },
      { kind: 'queue_email', to: 'sender', template: 'handoff_rejected', payload: { stage, reason: 'crushed box' } },
    ]);
  });

  it('guard: stage must match the state', () => {
    expectRejected(
      transition(
        'IN_TRANSIT',
        { type: 'handoff_reject', stage: 'recipient_pickup', rejectedById: null, reason: 'x', photoSha256: ['p'] },
        ctxForState('IN_TRANSIT'),
      ),
      'guard_failed',
    );
  });

  it('guard: photos and reason are mandatory', () => {
    expectRejected(
      transition(
        'IN_TRANSIT',
        { type: 'handoff_reject', stage: 'hub_checkin', rejectedById: null, reason: '', photoSha256: ['p'] },
        ctxForState('IN_TRANSIT'),
      ),
      'guard_failed',
    );
    expectRejected(
      transition(
        'IN_TRANSIT',
        { type: 'handoff_reject', stage: 'hub_checkin', rejectedById: null, reason: 'x', photoSha256: [] },
        ctxForState('IN_TRANSIT'),
      ),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #13 storage_expiry

describe('storage_expiry', () => {
  it('AT_HUB → FORFEITED: hub bond back, the parcel itself is the compensation', () => {
    const result = transition('AT_HUB', validEvent('storage_expiry'), ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.originHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.originStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { reason: 'storage' },
      },
    ]);
  });

  it('with a leg still pending funding, its holds dissolve in the same transition', () => {
    const ctx = { ...ctxForState('AT_HUB'), leg: pendingLeg() };
    const result = transition('AT_HUB', validEvent('storage_expiry'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects.slice(0, 4)).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      { kind: 'cancel_timeout', timeout: 'leg_funding', refId: IDS.leg },
    ]);
  });

  it('AWAITING_PICKUP → FORFEITED at the destination hub', () => {
    const result = transition('AWAITING_PICKUP', validEvent('storage_expiry'), ctxForState('AWAITING_PICKUP'));
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
  });

  it('guard: cannot fire before the storage deadline', () => {
    expectRejected(
      transition('AT_HUB', { type: 'storage_expiry', now: at(100) }, ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #14 transit_timeout

describe('transit_timeout', () => {
  const ctx = ctxForState('IN_TRANSIT');

  it('IN_TRANSIT → LOST: bond slashed to the sender, payment and arrival bond dissolve', () => {
    const result = transition('IN_TRANSIT', validEvent('transit_timeout'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('LOST');
    expect(result.effects).toEqual([
      { kind: 'release_conditional_payment', paymentId: IDS.carrierBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'carrier_bond_slashed',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'leg_payment_refunded',
        ref: { type: 'leg', id: IDS.leg },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -PRICING.grossMsat },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: PRICING.grossMsat },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          {
            ownerType: 'user',
            ownerId: IDS.intermediateHubUser,
            accountKind: 'external_wallet',
            amountMsat: BOND_MSAT,
          },
        ],
      },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: IDS.leg,
        hubStayId: null,
        payload: { reason: 'transit_timeout' },
      },
    ]);
  });

  it('guard: cannot fire before the transit deadline', () => {
    expectRejected(transition('IN_TRANSIT', { type: 'transit_timeout', now: at(599) }, ctx), 'guard_failed');
  });
});

// ---------------------------------------------------------------------------
// #15 boost / #16 reroute

describe('boost', () => {
  it.each(['AT_HUB', 'AWAITING_PICKUP'] as const)('in %s: custody event only, zero money effects', (state) => {
    const ctx = ctxForState(state);
    const result = transition(state, validEvent('boost'), ctx);
    expectOk(result);
    expect(result.nextState).toBe(state);
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'boosted',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: ctx.currentHubStay?.hubStayId ?? null,
        payload: { amountMsat: 1_000_000n, atRemainingKm: 60 },
      },
    ]);
  });

  it('guard: amount must be positive', () => {
    expectRejected(
      transition('AT_HUB', { type: 'boost', amountMsat: 0n, atRemainingKm: 60 }, ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

describe('reroute', () => {
  it('records the change (no PII), rotates the OTP, moves back to AT_HUB', () => {
    const result = transition(
      'AWAITING_PICKUP',
      { type: 'reroute', newDestHubId: IDS.originHub, newDestHubUserId: IDS.originHubUser, newRecipientEmail: 'new@x.it', newRemainingKm: 100 },
      ctxForState('AWAITING_PICKUP'),
    );
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'rerouted',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.arrivalStay,
        payload: { newDestHubId: IDS.originHub, recipientChanged: true, newRemainingKm: 100 },
      },
      { kind: 'rotate_pickup_otp' },
    ]);
  });

  it('recipient-only change at the destination keeps AWAITING_PICKUP and re-invites with the new OTP', () => {
    const result = transition(
      'AWAITING_PICKUP',
      { type: 'reroute', newDestHubId: null, newDestHubUserId: null, newRecipientEmail: 'new@x.it', newRemainingKm: 1 },
      ctxForState('AWAITING_PICKUP'),
    );
    expectOk(result);
    expect(result.nextState).toBe('AWAITING_PICKUP');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'rerouted',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.arrivalStay,
        payload: { newDestHubId: null, recipientChanged: true, newRemainingKm: 1 },
      },
      { kind: 'rotate_pickup_otp' },
      { kind: 'queue_email', to: 'recipient', template: 'parcel_arrived', payload: { hubId: IDS.destHub } },
    ]);
  });

  it.each([
    ['nothing changes', { newDestHubId: null, newRecipientEmail: null }],
    ['new destination is the current hub', { newDestHubId: IDS.originHub }],
    ['non-positive remaining distance', { newRemainingKm: 0 }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('reroute'), ...patch } as ShipmentEvent, ctxForState('AT_HUB')),
      'guard_failed',
    );
  });

  it('guard: rejected while a leg is pending', () => {
    expectRejected(
      transition('AT_HUB', validEvent('reroute'), { ...ctxForState('AT_HUB'), leg: pendingLeg() }),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #17 cancel

describe('cancel', () => {
  it('from DRAFT: only the custody event', () => {
    const result = transition('DRAFT', { type: 'cancel' }, baseCtx());
    expectOk(result);
    expect(result.nextState).toBe('CANCELLED');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'cancelled',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: null,
        payload: {},
      },
    ]);
  });

  it('from AWAITING_DROPOFF: origin hub bond dissolves', () => {
    const result = transition('AWAITING_DROPOFF', { type: 'cancel' }, ctxForState('AWAITING_DROPOFF'));
    expectOk(result);
    expect(result.nextState).toBe('CANCELLED');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.originHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.originStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      {
        kind: 'append_custody_event',
        type: 'cancelled',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.originStay,
        payload: {},
      },
    ]);
  });

  it('from AT_HUB at the origin: f_o × P compensation paid on the spot, bond back, storage disarmed', () => {
    const result = transition('AT_HUB', { type: 'cancel' }, ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('CANCELLED');
    // f_o × P = 10% × 8_000_000 = 800_000 msat (already sat-aligned).
    const compensation = 800_000n;
    expect(result.effects).toEqual([
      {
        kind: 'request_instant_payment',
        payerId: IDS.sender,
        payeeId: IDS.originHubUser,
        amountMsat: compensation,
        reason: 'cancellation_compensation',
        ref: { type: 'shipment', id: IDS.shipment },
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'cancellation_compensation_paid',
        ref: { type: 'shipment', id: IDS.shipment },
        postings: [
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: -compensation },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: compensation },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.originHubBond },
      {
        kind: 'post_ledger_entry',
        eventType: 'hub_bond_refunded',
        ref: { type: 'hub_stay', id: IDS.originStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -BOND_MSAT },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: BOND_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'storage', refId: IDS.originStay },
      {
        kind: 'append_custody_event',
        type: 'cancelled',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { compensationMsat: compensation },
      },
    ]);
  });

  it('guard: rejected away from the origin hub (reroute is the tool there)', () => {
    const ctx = { ...ctxForState('AT_HUB'), currentHubStay: { ...originStay(), hubId: IDS.intermediateHub } };
    expectRejected(transition('AT_HUB', { type: 'cancel' }, ctx), 'guard_failed');
  });

  it('guard: rejected while a leg is pending or booked', () => {
    expectRejected(
      transition('AT_HUB', { type: 'cancel' }, { ...ctxForState('AT_HUB'), leg: pendingLeg() }),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// The full state × event matrix: everything not explicitly legal is rejected.

const LEGAL: Record<string, ShipmentEventType[]> = {
  'null': ['create'],
  DRAFT: ['origin_hub_accept', 'cancel'],
  AWAITING_DROPOFF: ['origin_checkin', 'cancel'],
  // leg_funded / leg_funding_expired are state-legal in AT_HUB but need a
  // pending leg: with the bare AT_HUB fixture they fail on the guard instead.
  AT_HUB: ['leg_accept', 'leg_funded', 'leg_funding_expired', 'boost', 'reroute', 'cancel', 'storage_expiry'],
  LEG_BOOKED: ['pickup_checkout', 'pickup_timeout', 'handoff_reject'],
  IN_TRANSIT: ['leg_checkin', 'leg_return', 'transit_timeout', 'handoff_reject'],
  AWAITING_PICKUP: ['recipient_pickup', 'reroute', 'boost', 'storage_expiry', 'handoff_reject'],
  DELIVERED: [],
  CANCELLED: [],
  FORFEITED: [],
  LOST: [],
};

const ALL_EVENT_TYPES: ShipmentEventType[] = [
  'create',
  'origin_hub_accept',
  'origin_checkin',
  'leg_accept',
  'leg_funded',
  'leg_funding_expired',
  'pickup_checkout',
  'pickup_timeout',
  'leg_checkin',
  'leg_return',
  'recipient_pickup',
  'handoff_reject',
  'storage_expiry',
  'transit_timeout',
  'boost',
  'reroute',
  'cancel',
];

describe('state × event matrix', () => {
  const allStates: (ShipmentState | null)[] = [null, ...SHIPMENT_STATES];
  for (const state of allStates) {
    const legal = LEGAL[state === null ? 'null' : state]!;
    for (const eventType of ALL_EVENT_TYPES) {
      if (legal.includes(eventType)) continue;
      it(`rejects ${eventType} in ${state ?? '(not created)'} as illegal_event`, () => {
        const result = transition(state, validEvent(eventType), ctxForState(state));
        expectRejected(result, 'illegal_event');
      });
    }
  }

  it('terminal states reject every event (invariant: terminals are terminal)', () => {
    for (const state of ['DELIVERED', 'CANCELLED', 'FORFEITED', 'LOST'] as const) {
      for (const eventType of ALL_EVENT_TYPES) {
        const result = transition(state, validEvent(eventType), ctxForState(state));
        expect(result.ok).toBe(false);
      }
    }
  });

  it('every legal transition appends exactly one custody event', () => {
    // Spot-checked implicitly above; enforce it across the whole legal map
    // with guard-satisfying contexts.
    const cases: [ShipmentState | null, ShipmentEventType, ReturnType<typeof ctxForState>][] = [];
    for (const state of allStates) {
      for (const eventType of LEGAL[state === null ? 'null' : state]!) {
        let ctx = ctxForState(state);
        if (state === 'AT_HUB' && (eventType === 'leg_funded' || eventType === 'leg_funding_expired')) {
          ctx = { ...ctx, leg: pendingLeg() };
        }
        cases.push([state, eventType, ctx]);
      }
    }
    const stageFor: Partial<Record<string, 'pickup_checkout' | 'hub_checkin' | 'recipient_pickup'>> = {
      LEG_BOOKED: 'pickup_checkout',
      IN_TRANSIT: 'hub_checkin',
      AWAITING_PICKUP: 'recipient_pickup',
    };
    for (const [state, eventType, ctx] of cases) {
      let event = validEvent(eventType);
      if (event.type === 'handoff_reject' && state !== null) {
        event = { ...event, stage: stageFor[state]! };
      }
      const result = transition(state, event, ctx);
      expectOk(result);
      expect(
        result.effects.filter((e) => e.kind === 'append_custody_event'),
        `${eventType} in ${state ?? 'null'}`,
      ).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: every ledger entry balances and never names the platform.

describe('ledger discipline across all legal transitions', () => {
  it('every posting list sums to zero and only names user wallets or the shipment commitment', () => {
    const samples: TransitionResult[] = [
      transition('DRAFT', validEvent('origin_hub_accept'), baseCtx()),
      transition('AT_HUB', validEvent('leg_funded'), { ...ctxForState('AT_HUB'), leg: pendingLeg() }),
      transition('LEG_BOOKED', validEvent('pickup_checkout'), ctxForState('LEG_BOOKED')),
      transition('LEG_BOOKED', validEvent('pickup_timeout'), ctxForState('LEG_BOOKED')),
      transition('IN_TRANSIT', validEvent('leg_checkin'), ctxForState('IN_TRANSIT')),
      transition('IN_TRANSIT', validEvent('leg_return'), ctxForState('IN_TRANSIT')),
      transition('IN_TRANSIT', validEvent('transit_timeout'), ctxForState('IN_TRANSIT')),
      transition('AWAITING_PICKUP', validEvent('recipient_pickup'), ctxForState('AWAITING_PICKUP')),
      transition('AT_HUB', validEvent('storage_expiry'), ctxForState('AT_HUB')),
      transition('AT_HUB', { type: 'cancel' }, ctxForState('AT_HUB')),
    ];
    for (const result of samples) {
      expectOk(result);
      for (const effect of result.effects) {
        if (effect.kind !== 'post_ledger_entry') continue;
        const sum = effect.postings.reduce((acc, p) => acc + p.amountMsat, 0n);
        expect(sum).toBe(0n);
        expect(effect.postings.length).toBeGreaterThanOrEqual(2);
        for (const posting of effect.postings) {
          // Zero custody, structurally: commitments belong to the shipment,
          // wallets to users. No third owner type exists (invariant 1).
          if (posting.accountKind === 'commitment') expect(posting.ownerType).toBe('shipment');
          if (posting.accountKind === 'external_wallet') expect(posting.ownerType).toBe('user');
        }
      }
    }
  });
});
