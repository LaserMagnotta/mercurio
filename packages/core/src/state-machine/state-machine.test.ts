// Exhaustive suite for the shipment state machine (ARCHITECTURE.md §5).
// Every LEGAL transition is asserted against its EXACT effect list (toEqual
// on the whole array, not just the final state), every illegal (state,
// event) pair is asserted rejected, and every guard in the §5 table has a
// dedicated failure case.

import { describe, expect, it } from 'vitest';
import type { ShipmentEvent, ShipmentEventType, ShipmentState, TransitionResult } from '@mercurio/shared';
import { SHIPMENT_STATES } from '@mercurio/shared';
import { transition } from './state-machine.js';
import {
  BOND_MSAT,
  CARRIER_BONUS_MSAT,
  CLAIM_PAYMENT_MSAT,
  DEADLINES,
  FINAL_PRICING,
  HUB_BONUS_MSAT,
  IDS,
  OFFER_MSAT,
  PRICING,
  at,
  baseCtx,
  bonusHold,
  bookedLeg,
  ctxForState,
  finalLeg,
  originStay,
  pendingClaim,
  pendingFinalLeg,
  pendingFinalRequest,
  pendingLeg,
  pendingRequest,
  RENEWED_WINDOW,
  validEvent,
} from './fixtures.js';

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

  it('creation-photo hashes land in the created payload, empty lists leave it untouched (ADR-022)', () => {
    const content = ['a'.repeat(64)];
    const sealed = ['b'.repeat(64)];
    const withPhotos = transition(
      null,
      { type: 'create', contentPhotoSha256: content, sealedPhotoSha256: sealed },
      baseCtx(),
    );
    expectOk(withPhotos);
    expect(withPhotos.effects[0]).toMatchObject({
      payload: { contentPhotoSha256: content, sealedPhotoSha256: sealed },
    });

    // Empty/absent lists must keep the payload byte-identical to the
    // pre-ADR-022 shape: no keys at all.
    const withEmpty = transition(
      null,
      { type: 'create', contentPhotoSha256: [], sealedPhotoSha256: [] },
      baseCtx(),
    );
    expectOk(withEmpty);
    const payload = (withEmpty.effects[0] as { payload: Record<string, unknown> }).payload;
    expect('contentPhotoSha256' in payload).toBe(false);
    expect('sealedPhotoSha256' in payload).toBe(false);
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

  it('guard: the work commitment must be the ADR-014 work part of the offer', () => {
    expectRejected(
      transition(null, { type: 'create' }, { ...baseCtx(), workCommitmentMsat: OFFER_MSAT }),
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
      // ADR-033: renewal reminder armed 24h before the bond window closes.
      { kind: 'schedule_timeout', timeout: 'bond_renewal', refId: IDS.originStay, at: at(5 * 24 * 60) },
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

  it('starts the storage clock, certifies the check-in and mails the tracking token', () => {
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
      // ADR-016: the recipient's claim token is minted with the journey and
      // travels only in the tracking email (hash-at-rest, like the OTP).
      { kind: 'rotate_claim_token' },
      { kind: 'queue_email', to: 'recipient', template: 'parcel_tracking', payload: { hubId: IDS.originHub } },
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
// #4a leg_request (ADR-029) — the money-free request phase

describe('leg_request', () => {
  const ctx = ctxForState('AT_HUB');

  it('freezes the price, arms the response window and moves NO money', () => {
    const result = transition('AT_HUB', validEvent('leg_request'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'schedule_timeout',
        timeout: 'deposit_response',
        refId: IDS.leg,
        at: DEADLINES.response,
      },
      {
        kind: 'append_custody_event',
        type: 'deposit_requested',
        actorUserId: IDS.carrier,
        legId: IDS.leg,
        hubStayId: null,
        payload: {
          toHubId: IDS.intermediateHub,
          grossMsat: PRICING.grossMsat,
          depHubFeeMsat: PRICING.depHubFeeMsat,
          arrHubFeeMsat: PRICING.arrHubFeeMsat,
          netMsat: PRICING.netMsat,
          finalizationBonusMsat: 0n,
          finalizationHubBonusMsat: 0n,
          custodyBondMsat: BOND_MSAT,
          responseDeadlineAt: DEADLINES.response,
        },
      },
    ]);
  });

  it('the request never carries a payment or ledger effect (ADR-029 invariant)', () => {
    const result = transition('AT_HUB', validEvent('leg_request'), ctx);
    expectOk(result);
    expect(
      result.effects.filter((e) =>
        [
          'create_conditional_payment',
          'release_conditional_payment',
          'refund_conditional_payment',
          'request_instant_payment',
          'post_ledger_entry',
        ].includes(e.kind),
      ),
    ).toEqual([]);
  });

  it('final leg: the frozen Π_h share is documented in the request payload', () => {
    const event = {
      ...validEvent('leg_request'),
      toHubId: IDS.destHub,
      toHubUserId: IDS.destHubUser,
      pricing: FINAL_PRICING,
      finalizationHubBonusMsat: HUB_BONUS_MSAT,
    } as ShipmentEvent;
    const result = transition('AT_HUB', event, ctx);
    expectOk(result);
    const custody = result.effects.find((e) => e.kind === 'append_custody_event');
    expect(custody).toMatchObject({
      type: 'deposit_requested',
      payload: {
        finalizationBonusMsat: CARRIER_BONUS_MSAT,
        finalizationHubBonusMsat: HUB_BONUS_MSAT,
      },
    });
    expect(result.effects.filter((e) => e.kind === 'create_conditional_payment')).toEqual([]);
  });

  it.each([
    ['carrier trip not active', { carrierTripActive: false }],
    ['carrier wallet disconnected', { carrierWalletConnected: false }],
    ['arrival hub wallet disconnected', { arrivalHubWalletConnected: false }],
    ['arrival hub equals current hub', { toHubId: IDS.originHub }],
    ['inconsistent pricing', { pricing: { ...PRICING, netMsat: PRICING.netMsat + 1n } }],
    [
      'zero gross',
      { pricing: { grossMsat: 0n, depHubFeeMsat: 0n, arrHubFeeMsat: 0n, netMsat: 0n, finalizationBonusMsat: 0n } },
    ],
    ['negative carrier bonus', { pricing: { ...PRICING, finalizationBonusMsat: -1n } }],
    ['negative hub bonus', { finalizationHubBonusMsat: -1n }],
    // Only the leg that delivers to the destination may carry either share.
    ['carrier bonus on a non-final leg', { pricing: { ...PRICING, finalizationBonusMsat: 1_000n } }],
    ['hub bonus on a non-final leg', { finalizationHubBonusMsat: HUB_BONUS_MSAT }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('leg_request'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });

  it('guard: only one pending request at a time (board-exclusive, decisione C)', () => {
    expectRejected(
      transition('AT_HUB', validEvent('leg_request'), { ...ctx, pendingLegRequest: pendingRequest() }),
      'guard_failed',
    );
  });

  it('guard: only one pending leg at a time', () => {
    expectRejected(
      transition('AT_HUB', validEvent('leg_request'), { ...ctx, leg: pendingLeg() }),
      'guard_failed',
    );
  });

  it('guard: rejected while a recipient claim is pending', () => {
    expectRejected(
      transition('AT_HUB', validEvent('leg_request'), { ...ctx, pendingClaim: pendingClaim() }),
      'guard_failed',
    );
  });

  it('guard: a stale finalization-bonus hold blocks new requests', () => {
    expectRejected(
      transition('AT_HUB', validEvent('leg_request'), { ...ctx, finalizationBonusHold: bonusHold() }),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #4b deposit_accept (ADR-029) — bit-per-bit the pre-ADR-029 leg_accept

describe('deposit_accept', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingRequest() };

  it('creates EXACTLY the old leg_accept holds and arms the funding window', () => {
    const result = transition('AT_HUB', validEvent('deposit_accept'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB'); // booked only when funded
    expect(result.effects).toEqual([
      // The 3 holds of ESCROW.md §3 — identical payer/payee/amount/ref to
      // what leg_accept created before ADR-029 (the "bit-per-bit" promise).
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
      { kind: 'cancel_timeout', timeout: 'deposit_response', refId: IDS.leg },
      { kind: 'schedule_timeout', timeout: 'leg_funding', refId: IDS.leg, at: DEADLINES.funding },
      {
        kind: 'append_custody_event',
        type: 'leg_accepted',
        actorUserId: IDS.intermediateHubUser, // the hub is the accepting party
        legId: IDS.leg,
        hubStayId: null,
        payload: {
          toHubId: IDS.intermediateHub,
          grossMsat: PRICING.grossMsat,
          depHubFeeMsat: PRICING.depHubFeeMsat,
          arrHubFeeMsat: PRICING.arrHubFeeMsat,
          netMsat: PRICING.netMsat,
          finalizationBonusMsat: 0n,
          finalizationHubBonusMsat: 0n,
          custodyBondMsat: BOND_MSAT,
        },
      },
    ]);
  });

  it('final request: the payment hold binds gross + Π_v and a fourth hold freezes Π_h (ADR-014)', () => {
    const finalCtx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingFinalRequest() };
    const result = transition('AT_HUB', validEvent('deposit_accept'), finalCtx);
    expectOk(result);
    const holds = result.effects.filter((e) => e.kind === 'create_conditional_payment');
    expect(holds).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'leg_payment',
        payerId: IDS.sender,
        payeeId: IDS.carrier,
        amountMsat: FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT,
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
        payerId: IDS.destHubUser,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
      },
      {
        kind: 'create_conditional_payment',
        purpose: 'finalization_bonus',
        payerId: IDS.sender,
        payeeId: IDS.destHubUser,
        amountMsat: HUB_BONUS_MSAT,
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
      },
    ]);
    const custody = result.effects.find((e) => e.kind === 'append_custody_event');
    expect(custody).toMatchObject({
      payload: {
        finalizationBonusMsat: CARRIER_BONUS_MSAT,
        finalizationHubBonusMsat: HUB_BONUS_MSAT,
      },
    });
  });

  it('final request with a zero hub share creates no fourth hold (mirrors zero fees)', () => {
    const finalCtx = {
      ...ctxForState('AT_HUB'),
      pendingLegRequest: { ...pendingFinalRequest(), finalizationHubBonusMsat: 0n },
    };
    const result = transition('AT_HUB', validEvent('deposit_accept'), finalCtx);
    expectOk(result);
    expect(result.effects.filter((e) => e.kind === 'create_conditional_payment')).toHaveLength(3);
  });

  it('guard: no pending request to accept', () => {
    expectRejected(
      transition('AT_HUB', validEvent('deposit_accept'), ctxForState('AT_HUB')),
      'guard_failed',
    );
  });

  it('guard: accepting after the response window is rejected', () => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('deposit_accept'), now: at(31) } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });

  it('guard: arrival hub wallet must be connected to bind its bond', () => {
    expectRejected(
      transition(
        'AT_HUB',
        { ...validEvent('deposit_accept'), arrivalHubWalletConnected: false } as ShipmentEvent,
        ctx,
      ),
      'guard_failed',
    );
  });

  it('guard: a stale finalization-bonus hold blocks the accept', () => {
    expectRejected(
      transition('AT_HUB', validEvent('deposit_accept'), { ...ctx, finalizationBonusHold: bonusHold() }),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// #4c–e deposit_reject / deposit_request_expired / deposit_request_cancel:
// zero-cost dissolutions (ADR-029 — no hold ever existed).

const MONEY_EFFECT_KINDS = [
  'create_conditional_payment',
  'release_conditional_payment',
  'refund_conditional_payment',
  'request_instant_payment',
  'post_ledger_entry',
];

describe('deposit_reject', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingRequest() };

  it('documents the refusal, disarms the window, notifies the carrier — zero money', () => {
    const result = transition('AT_HUB', validEvent('deposit_reject'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'cancel_timeout', timeout: 'deposit_response', refId: IDS.leg },
      {
        kind: 'append_custody_event',
        type: 'handoff_rejected',
        actorUserId: IDS.intermediateHubUser,
        legId: IDS.leg,
        hubStayId: null,
        payload: { stage: 'deposit_request', reason: 'shelf is full this week' },
      },
      {
        kind: 'queue_email',
        to: 'carrier',
        template: 'deposit_request_rejected',
        payload: { hubId: IDS.intermediateHub, outcome: 'rejected', reason: 'shelf is full this week' },
      },
    ]);
    expect(result.effects.filter((e) => MONEY_EFFECT_KINDS.includes(e.kind))).toEqual([]);
  });

  it('guard: a reason is required (documentation, ADR-012)', () => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('deposit_reject'), reason: '  ' } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });

  it('guard: no pending request to reject', () => {
    expectRejected(
      transition('AT_HUB', validEvent('deposit_reject'), ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

describe('deposit_request_expired', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingRequest() };

  it('the silent hub: chain event + carrier email, consumes its own timer, zero money', () => {
    const result = transition('AT_HUB', validEvent('deposit_request_expired'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: IDS.leg,
        hubStayId: null,
        payload: { reason: 'deposit_response' },
      },
      {
        kind: 'queue_email',
        to: 'carrier',
        template: 'deposit_request_rejected',
        payload: { hubId: IDS.intermediateHub, outcome: 'expired' },
      },
    ]);
    expect(result.effects.filter((e) => MONEY_EFFECT_KINDS.includes(e.kind))).toEqual([]);
  });

  it('guard: cannot expire before the window closes', () => {
    expectRejected(
      transition('AT_HUB', { type: 'deposit_request_expired', now: at(29) }, ctx),
      'guard_failed',
    );
  });

  it('guard: no pending request to expire', () => {
    expectRejected(
      transition('AT_HUB', validEvent('deposit_request_expired'), ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

describe('deposit_request_cancel', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingRequest() };

  it('the carrier withdraws: window disarmed, chain event, no email, zero money', () => {
    const result = transition('AT_HUB', validEvent('deposit_request_cancel'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'cancel_timeout', timeout: 'deposit_response', refId: IDS.leg },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: IDS.carrier,
        legId: IDS.leg,
        hubStayId: null,
        payload: { reason: 'deposit_request_cancelled' },
      },
    ]);
    expect(result.effects.filter((e) => MONEY_EFFECT_KINDS.includes(e.kind))).toEqual([]);
  });

  it('guard: no pending request to cancel', () => {
    expectRejected(
      transition('AT_HUB', validEvent('deposit_request_cancel'), ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// Deposit-request interactions with the rest of the protocol (ADR-029)

describe('deposit-request interactions (ADR-029)', () => {
  const pendingReqCtx = { ...ctxForState('AT_HUB'), pendingLegRequest: pendingRequest() };

  it('recipient_claim, boost, reroute and cancel are rejected while a request is pending', () => {
    expectRejected(transition('AT_HUB', validEvent('recipient_claim'), pendingReqCtx), 'guard_failed');
    expectRejected(transition('AT_HUB', validEvent('boost'), pendingReqCtx), 'guard_failed');
    expectRejected(transition('AT_HUB', validEvent('reroute'), pendingReqCtx), 'guard_failed');
    expectRejected(transition('AT_HUB', { type: 'cancel' }, pendingReqCtx), 'guard_failed');
  });

  it('storage_expiry with a pending request: only the response window dissolves — zero request money', () => {
    const result = transition('AT_HUB', validEvent('storage_expiry'), pendingReqCtx);
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects).toEqual([
      { kind: 'cancel_timeout', timeout: 'deposit_response', refId: IDS.leg },
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
      // The stay's own bond refund + chain event follow, as in every expiry.
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
        payload: {
          grossMsat: PRICING.grossMsat,
          finalizationBonusMsat: 0n,
          finalizationHubBonusMsat: 0n,
          custodyBondMsat: BOND_MSAT,
        },
      },
    ]);
  });

  it('final leg: LEG_BOOKED recognizes all FOUR held commitments (ADR-014)', () => {
    const finalCtx = {
      ...ctxForState('AT_HUB'),
      leg: pendingFinalLeg(),
      finalizationBonusHold: bonusHold(),
    };
    const result = transition('AT_HUB', validEvent('leg_funded'), finalCtx);
    expectOk(result);
    expect(result.nextState).toBe('LEG_BOOKED');
    const entries = result.effects.filter((e) => e.kind === 'post_ledger_entry');
    expect(entries.map((e) => e.eventType)).toEqual([
      'leg_payment_held',
      'carrier_bond_held',
      'hub_bond_held',
      'finalization_bonus_held',
    ]);
    // The payment hold binds gross + Π_v; the fourth hold is the sender's Π_h.
    expect(entries[0]!.postings).toEqual([
      {
        ownerType: 'user',
        ownerId: IDS.sender,
        accountKind: 'external_wallet',
        amountMsat: -(FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT),
      },
      {
        ownerType: 'shipment',
        ownerId: IDS.shipment,
        accountKind: 'commitment',
        amountMsat: FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT,
      },
    ]);
    expect(entries[3]).toEqual({
      kind: 'post_ledger_entry',
      eventType: 'finalization_bonus_held',
      ref: { type: 'hub_stay', id: IDS.arrivalStay },
      postings: [
        { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: -HUB_BONUS_MSAT },
        { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: HUB_BONUS_MSAT },
      ],
    });
    const custody = result.effects.find((e) => e.kind === 'append_custody_event');
    expect(custody).toMatchObject({
      payload: {
        grossMsat: FINAL_PRICING.grossMsat,
        finalizationBonusMsat: CARRIER_BONUS_MSAT,
        finalizationHubBonusMsat: HUB_BONUS_MSAT,
      },
    });
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

  it('an expired final leg also cancels the Π_h hold, still with no entries', () => {
    const finalCtx = {
      ...ctxForState('AT_HUB'),
      leg: pendingFinalLeg(),
      finalizationBonusHold: bonusHold(),
    };
    const result = transition('AT_HUB', validEvent('leg_funding_expired'), finalCtx);
    expectOk(result);
    expect(result.effects.filter((e) => e.kind === 'refund_conditional_payment')).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.finalizationBonus },
    ]);
    expect(result.effects.filter((e) => e.kind === 'post_ledger_entry')).toEqual([]);
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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

  it('a timed-out final leg refunds the whole hold (gross + Π_v) and the Π_h hold', () => {
    const finalCtx = {
      ...ctxForState('LEG_BOOKED'),
      leg: { ...pendingFinalLeg(), pickupDeadlineAt: DEADLINES.pickup },
      finalizationBonusHold: bonusHold(),
    };
    const result = transition('LEG_BOOKED', validEvent('pickup_timeout'), finalCtx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    const entries = result.effects.filter((e) => e.kind === 'post_ledger_entry');
    expect(entries.map((e) => e.eventType)).toEqual([
      'carrier_bond_slashed',
      'leg_payment_refunded',
      'hub_bond_refunded',
      'finalization_bonus_refunded',
    ]);
    expect(entries[1]!.postings[1]!.amountMsat).toBe(FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT);
    expect(result.effects).toContainEqual({
      kind: 'refund_conditional_payment',
      paymentId: IDS.finalizationBonus,
    });
    expect(entries[3]).toEqual({
      kind: 'post_ledger_entry',
      eventType: 'finalization_bonus_refunded',
      ref: { type: 'hub_stay', id: IDS.arrivalStay },
      postings: [
        { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
        { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
      ],
    });
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
      // ADR-033: the arrival bond's renewal reminder starts with the stay.
      { kind: 'schedule_timeout', timeout: 'bond_renewal', refId: IDS.arrivalStay, at: at(5 * 24 * 60) },
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
  const ctx = { ...ctxForState('IN_TRANSIT'), leg: finalLeg(), finalizationBonusHold: bonusHold() };
  const event = { ...validEvent('leg_checkin'), hubId: IDS.destHub } as ShipmentEvent;

  it('carrier collects gross + Π_v in one release; the Π_h hold stays for the pickup', () => {
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
    // Money mirrors the intermediate case (fee + release + bond refund) but
    // the release settles the WHOLE hold: gross plus the carrier bonus share.
    // The arrival fee stays computed on the gross alone (the bonus pays no
    // fees, ADR-014) and the Π_h hold is deliberately untouched here.
    expect(result.effects.filter((e) => e.kind === 'release_conditional_payment')).toEqual([
      { kind: 'release_conditional_payment', paymentId: IDS.legPayment },
    ]);
    expect(result.effects.filter((e) => e.kind === 'refund_conditional_payment')).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
    ]);
    const released = result.effects.find(
      (e) => e.kind === 'post_ledger_entry' && e.eventType === 'leg_payment_released',
    );
    expect(released).toEqual({
      kind: 'post_ledger_entry',
      eventType: 'leg_payment_released',
      ref: { type: 'leg', id: IDS.leg },
      postings: [
        {
          ownerType: 'shipment',
          ownerId: IDS.shipment,
          accountKind: 'commitment',
          amountMsat: -(FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT),
        },
        {
          ownerType: 'user',
          ownerId: IDS.carrier,
          accountKind: 'external_wallet',
          amountMsat: FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT,
        },
      ],
    });
    const fee = result.effects.find((e) => e.kind === 'request_instant_payment');
    expect(fee).toMatchObject({ amountMsat: FINAL_PRICING.arrHubFeeMsat });
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
      // ADR-033: fresh bond, fresh renewal window.
      { kind: 'schedule_timeout', timeout: 'bond_renewal', refId: IDS.returnStay, at: at(5 * 24 * 60) },
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

  it('a returned final leg also dissolves the Π_h hold (ADR-014)', () => {
    const finalCtx = { ...ctxForState('IN_TRANSIT'), leg: finalLeg(), finalizationBonusHold: bonusHold() };
    const result = transition('IN_TRANSIT', validEvent('leg_return'), finalCtx);
    expectOk(result);
    expect(result.effects).toContainEqual({
      kind: 'refund_conditional_payment',
      paymentId: IDS.finalizationBonus,
    });
    const refunded = result.effects.find(
      (e) => e.kind === 'post_ledger_entry' && e.eventType === 'finalization_bonus_refunded',
    );
    expect(refunded).toMatchObject({ ref: { type: 'hub_stay', id: IDS.arrivalStay } });
    const paymentRefund = result.effects.find(
      (e) => e.kind === 'post_ledger_entry' && e.eventType === 'leg_payment_refunded',
    );
    expect(paymentRefund!.kind === 'post_ledger_entry' && paymentRefund.postings[1]!.amountMsat).toBe(
      FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT,
    );
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

  it('OTP closes the shipment: Π_h released to the hub, bond back, storage disarmed, sender notified', () => {
    const result = transition('AWAITING_PICKUP', validEvent('recipient_pickup'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('DELIVERED');
    expect(result.effects).toEqual([
      // The hub is rewarded for the COMPLETED delivery, not for the arrival:
      // the Π_h preimage is revealed only now (ADR-014).
      { kind: 'release_conditional_payment', paymentId: IDS.finalizationBonus },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_released',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'user', ownerId: IDS.destHubUser, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
        ],
      },
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.arrivalStay },
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

  it('without a pending Π_h hold (pre-ADR-014 shipments) only the bond moves', () => {
    const result = transition('AWAITING_PICKUP', validEvent('recipient_pickup'), {
      ...ctx,
      finalizationBonusHold: null,
    });
    expectOk(result);
    expect(result.effects.filter((e) => e.kind === 'release_conditional_payment')).toEqual([]);
    expect(result.effects.filter((e) => e.kind === 'post_ledger_entry')).toHaveLength(1);
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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

  it('a pending FINAL leg dissolves its Π_h hold too (no entries: never funded)', () => {
    const ctx = {
      ...ctxForState('AT_HUB'),
      leg: pendingFinalLeg(),
      finalizationBonusHold: bonusHold(),
    };
    const result = transition('AT_HUB', validEvent('storage_expiry'), ctx);
    expectOk(result);
    expect(result.effects.slice(0, 5)).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.finalizationBonus },
      { kind: 'cancel_timeout', timeout: 'leg_funding', refId: IDS.leg },
    ]);
  });

  it('AWAITING_PICKUP → FORFEITED: the held Π_h returns to the sender, the parcel compensates the hub', () => {
    const result = transition('AWAITING_PICKUP', validEvent('storage_expiry'), ctxForState('AWAITING_PICKUP'));
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects.slice(0, 2)).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.finalizationBonus },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
        ],
      },
    ]);
  });

  it('guard: cannot fire before the storage deadline', () => {
    expectRejected(
      transition('AT_HUB', { type: 'storage_expiry', now: at(100) }, ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

// ---------------------------------------------------------------------------
// bond_renew (ADR-033): rolling renewal of the hub-bond hold

describe('bond_renew (ADR-033)', () => {
  // The renewed bond's next reminder: 24h before RENEWED_WINDOW closes.
  const nextFireAt = at(12 * 24 * 60 - 60);

  it('replaces the bond hold: new hold held first, old refunded, timer re-armed, chain documents the window', () => {
    const result = transition('AT_HUB', validEvent('bond_renew'), ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'custody_bond',
        payerId: IDS.originHubUser,
        payeeId: IDS.sender,
        amountMsat: BOND_MSAT,
        ref: { type: 'hub_stay', id: IDS.originStay },
        idemNonce: RENEWED_WINDOW,
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
      { kind: 'schedule_timeout', timeout: 'bond_renewal', refId: IDS.originStay, at: nextFireAt },
      {
        kind: 'append_custody_event',
        type: 'bond_renewed',
        actorUserId: IDS.originHubUser,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { custodyBondMsat: BOND_MSAT, bondWindowEndsAt: RENEWED_WINDOW },
      },
    ]);
  });

  it.each(['AWAITING_DROPOFF', 'LEG_BOOKED', 'CLAIMED'] as const)(
    'keeps the state while renewing in %s',
    (state) => {
      const result = transition(state, validEvent('bond_renew'), ctxForState(state));
      expectOk(result);
      expect(result.nextState).toBe(state);
      expect(result.effects[0]).toMatchObject({ kind: 'create_conditional_payment', purpose: 'custody_bond' });
    },
  );

  it('guard: a stay that is no longer current is stale', () => {
    const event = { ...validEvent('bond_renew'), hubStayId: 'stay-somewhere-else' } as ShipmentEvent;
    expectRejected(transition('AT_HUB', event, ctxForState('AT_HUB')), 'guard_failed');
  });

  it('guard: a legacy stay without a bond window never renews', () => {
    const ctx = { ...ctxForState('AT_HUB'), currentHubStay: { ...originStay(), bondWindowEndsAt: null } };
    expectRejected(transition('AT_HUB', validEvent('bond_renew'), ctx), 'guard_failed');
  });

  it('guard: no renewal when the window already covers the storage deadline', () => {
    const stay = { ...originStay(), storageDeadlineAt: at(5 * 24 * 60), bondWindowEndsAt: at(6 * 24 * 60) };
    const ctx = { ...ctxForState('AT_HUB'), currentHubStay: stay };
    expectRejected(transition('AT_HUB', validEvent('bond_renew'), ctx), 'guard_failed');
  });

  it('missed renewal in AT_HUB: early storage end — FORFEITED, storage disarmed, sender mailed', () => {
    const event = { ...validEvent('bond_renew'), now: at(6 * 24 * 60 + 1) } as ShipmentEvent;
    const result = transition('AT_HUB', event, ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects).toEqual([
      { kind: 'cancel_timeout', timeout: 'storage', refId: IDS.originStay },
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
        payload: { reason: 'bond_renewal' },
      },
      { kind: 'queue_email', to: 'sender', template: 'hub_bond_lapsed', payload: { hubId: IDS.originHub, phase: 'storage' } },
    ]);
  });

  it('missed renewal in AT_HUB with a pending leg: its holds dissolve like a storage expiry', () => {
    const event = { ...validEvent('bond_renew'), now: at(6 * 24 * 60 + 1) } as ShipmentEvent;
    const ctx = { ...ctxForState('AT_HUB'), leg: pendingLeg() };
    const result = transition('AT_HUB', event, ctx);
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects.slice(0, 4)).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.legPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.carrierBond },
      { kind: 'refund_conditional_payment', paymentId: IDS.arrivalHubBond },
      { kind: 'cancel_timeout', timeout: 'leg_funding', refId: IDS.leg },
    ]);
  });

  it('missed renewal in AWAITING_DROPOFF: the reservation dissolves at zero cost — CANCELLED', () => {
    const event = { ...validEvent('bond_renew'), now: at(6 * 24 * 60 + 1) } as ShipmentEvent;
    const result = transition('AWAITING_DROPOFF', event, ctxForState('AWAITING_DROPOFF'));
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
        actorUserId: null,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { reason: 'bond_renewal' },
      },
      { kind: 'queue_email', to: 'sender', template: 'hub_bond_lapsed', payload: { hubId: IDS.originHub, phase: 'dropoff' } },
    ]);
  });

  it('missed renewal in LEG_BOOKED still attempts the renewal (never punish the booked carrier)', () => {
    const event = { ...validEvent('bond_renew'), now: at(6 * 24 * 60 + 1) } as ShipmentEvent;
    const result = transition('LEG_BOOKED', event, ctxForState('LEG_BOOKED'));
    expectOk(result);
    expect(result.nextState).toBe('LEG_BOOKED');
    expect(result.effects[0]).toMatchObject({ kind: 'create_conditional_payment', purpose: 'custody_bond' });
  });

  it('rejected while IN_TRANSIT (the carrier is the custodian, no stay holds a bond)', () => {
    expectRejected(
      transition('IN_TRANSIT', validEvent('bond_renew'), ctxForState('IN_TRANSIT')),
      'illegal_event',
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

  it('a lost final leg refunds gross + Π_v to the sender and dissolves the Π_h hold', () => {
    const finalCtx = { ...ctxForState('IN_TRANSIT'), leg: finalLeg(), finalizationBonusHold: bonusHold() };
    const result = transition('IN_TRANSIT', validEvent('transit_timeout'), finalCtx);
    expectOk(result);
    expect(result.nextState).toBe('LOST');
    const entries = result.effects.filter((e) => e.kind === 'post_ledger_entry');
    expect(entries.map((e) => e.eventType)).toEqual([
      'carrier_bond_slashed',
      'leg_payment_refunded',
      'hub_bond_refunded',
      'finalization_bonus_refunded',
    ]);
    expect(entries[1]!.postings[1]!.amountMsat).toBe(FINAL_PRICING.grossMsat + CARRIER_BONUS_MSAT);
    expect(result.effects).toContainEqual({
      kind: 'refund_conditional_payment',
      paymentId: IDS.finalizationBonus,
    });
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
  it('away from the delivery state: cancels the Π_h hold (a new final leg will freeze a fresh one)', () => {
    const result = transition(
      'AWAITING_PICKUP',
      { type: 'reroute', newDestHubId: IDS.originHub, newDestHubUserId: IDS.originHubUser, newRecipientEmail: 'new@x.it', newRemainingKm: 100 },
      ctxForState('AWAITING_PICKUP'),
    );
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.finalizationBonus },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_refunded',
        ref: { type: 'hub_stay', id: IDS.arrivalStay },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
        ],
      },
      {
        kind: 'append_custody_event',
        type: 'rerouted',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.arrivalStay,
        payload: { newDestHubId: IDS.originHub, recipientChanged: true, newRemainingKm: 100 },
      },
      { kind: 'rotate_pickup_otp' },
      // The recipient changed: their claim token rotates with them (ADR-016).
      { kind: 'rotate_claim_token' },
      { kind: 'queue_email', to: 'recipient', template: 'parcel_tracking', payload: { hubId: IDS.destHub } },
    ]);
  });

  it('from AT_HUB (no bonus hold in play): custody event and OTP rotation only', () => {
    const result = transition('AT_HUB', validEvent('reroute'), ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      {
        kind: 'append_custody_event',
        type: 'rerouted',
        actorUserId: IDS.sender,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { newDestHubId: IDS.intermediateHub, recipientChanged: false, newRemainingKm: 60 },
      },
      { kind: 'rotate_pickup_otp' },
    ]);
  });

  it('recipient-only change at the destination keeps AWAITING_PICKUP — and keeps the Π_h hold', () => {
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
      { kind: 'rotate_claim_token' },
      { kind: 'queue_email', to: 'recipient', template: 'parcel_tracking', payload: { hubId: IDS.destHub } },
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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

  it('from AT_HUB at the origin: f_o × work commitment paid on the spot, bond back, storage disarmed', () => {
    const result = transition('AT_HUB', { type: 'cancel' }, ctxForState('AT_HUB'));
    expectOk(result);
    expect(result.nextState).toBe('CANCELLED');
    // f_o × work commitment = 10% × 7_200_000 = 720_000 msat (ADR-014: the
    // bonus is excluded from the compensation formula too).
    const compensation = 720_000n;
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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
// #18–21 recipient claim (ADR-016)

describe('recipient_claim', () => {
  const ctx = ctxForState('AT_HUB');

  it('opens the claim payment and Π_h holds, arms the funding window, stays AT_HUB', () => {
    const result = transition('AT_HUB', validEvent('recipient_claim'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB'); // CLAIMED only when funded
    expect(result.effects).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'claim_payment',
        payerId: IDS.sender,
        payeeId: IDS.claimant,
        amountMsat: CLAIM_PAYMENT_MSAT,
        ref: { type: 'claim', id: IDS.claim },
      },
      {
        kind: 'create_conditional_payment',
        purpose: 'finalization_bonus',
        payerId: IDS.sender,
        payeeId: IDS.originHubUser,
        amountMsat: HUB_BONUS_MSAT,
        ref: { type: 'claim', id: IDS.claim },
      },
      { kind: 'schedule_timeout', timeout: 'claim_funding', refId: IDS.claim, at: DEADLINES.funding },
      {
        kind: 'append_custody_event',
        type: 'claim_requested',
        actorUserId: IDS.claimant,
        legId: null,
        hubStayId: IDS.originStay,
        payload: {
          claimId: IDS.claim,
          claimPaymentMsat: CLAIM_PAYMENT_MSAT,
          hubBonusMsat: HUB_BONUS_MSAT,
        },
      },
    ]);
  });

  it('a zero Π_h creates no second hold (mirrors zero fees)', () => {
    const event = { ...validEvent('recipient_claim'), hubBonusMsat: 0n } as ShipmentEvent;
    const result = transition('AT_HUB', event, ctx);
    expectOk(result);
    expect(result.effects.filter((e) => e.kind === 'create_conditional_payment')).toEqual([
      {
        kind: 'create_conditional_payment',
        purpose: 'claim_payment',
        payerId: IDS.sender,
        payeeId: IDS.claimant,
        amountMsat: CLAIM_PAYMENT_MSAT,
        ref: { type: 'claim', id: IDS.claim },
      },
    ]);
  });

  it.each([
    ['unverified claim token', { claimTokenVerified: false }],
    ['claimant wallet disconnected', { claimantWalletConnected: false }],
    ['claimant is the sender', { claimantId: IDS.sender }],
    ['claimant owns the pickup hub', { claimantId: IDS.originHubUser }],
    // Zero-amount holds do not exist on Lightning: nothing left to collect
    // means no claim — the sender must boost first (ADR-016).
    ['nothing to collect', { claimPaymentMsat: 0n }],
    ['negative hub bonus', { hubBonusMsat: -1n }],
  ])('guard: %s', (_name, patch) => {
    expectRejected(
      transition('AT_HUB', { ...validEvent('recipient_claim'), ...patch } as ShipmentEvent, ctx),
      'guard_failed',
    );
  });

  it('guard: rejected while a leg is pending', () => {
    expectRejected(
      transition('AT_HUB', validEvent('recipient_claim'), { ...ctx, leg: pendingLeg() }),
      'guard_failed',
    );
  });

  it('guard: rejected while another claim is pending', () => {
    expectRejected(
      transition('AT_HUB', validEvent('recipient_claim'), { ...ctx, pendingClaim: pendingClaim() }),
      'guard_failed',
    );
  });

  it('guard: a stale finalization-bonus hold blocks the claim (as it blocks leg_accept)', () => {
    expectRejected(
      transition('AT_HUB', validEvent('recipient_claim'), { ...ctx, finalizationBonusHold: bonusHold() }),
      'guard_failed',
    );
  });

  it('NOT legal from AWAITING_PICKUP: the OTP pickup already exists there', () => {
    expectRejected(
      transition('AWAITING_PICKUP', validEvent('recipient_claim'), ctxForState('AWAITING_PICKUP')),
      'illegal_event',
    );
  });
});

describe('claim_funded', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingClaim: pendingClaim() };

  it('books the pickup: both commitments enter the ledger, storage keeps running', () => {
    const result = transition('AT_HUB', validEvent('claim_funded'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('CLAIMED');
    expect(result.effects).toEqual([
      {
        kind: 'post_ledger_entry',
        eventType: 'claim_payment_held',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: -CLAIM_PAYMENT_MSAT },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: CLAIM_PAYMENT_MSAT },
        ],
      },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_held',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: HUB_BONUS_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'claim_funding', refId: IDS.claim },
      // No storage cancel_timeout: the stay keeps its deadline (ADR-016).
      {
        kind: 'append_custody_event',
        type: 'funded',
        actorUserId: null,
        legId: null,
        hubStayId: IDS.originStay,
        payload: {
          claimId: IDS.claim,
          claimPaymentMsat: CLAIM_PAYMENT_MSAT,
          hubBonusMsat: HUB_BONUS_MSAT,
        },
      },
    ]);
  });

  it('with no Π_h hold: only the claim payment enters the ledger', () => {
    const claim = { ...pendingClaim(), hubBonusMsat: 0n, hubBonusPaymentId: null };
    const result = transition('AT_HUB', validEvent('claim_funded'), { ...ctx, pendingClaim: claim });
    expectOk(result);
    const entries = result.effects.filter((e) => e.kind === 'post_ledger_entry');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ eventType: 'claim_payment_held' });
  });

  it('guard: no pending claim to fund', () => {
    expectRejected(transition('AT_HUB', validEvent('claim_funded'), ctxForState('AT_HUB')), 'guard_failed');
  });

  it('guard: funding window expired', () => {
    expectRejected(transition('AT_HUB', { type: 'claim_funded', now: at(61) }, ctx), 'guard_failed');
  });
});

describe('claim_funding_expired', () => {
  const ctx = { ...ctxForState('AT_HUB'), pendingClaim: pendingClaim() };

  it('dissolves both holds with NO journal entries and returns the parcel to the board', () => {
    const result = transition('AT_HUB', validEvent('claim_funding_expired'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('AT_HUB');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.claimPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.claimHubBonus },
      {
        kind: 'append_custody_event',
        type: 'expired',
        actorUserId: null,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { reason: 'claim_funding', claimId: IDS.claim },
      },
    ]);
  });

  it('guard: window not expired yet', () => {
    expectRejected(transition('AT_HUB', { type: 'claim_funding_expired', now: at(59) }, ctx), 'guard_failed');
  });

  it('guard: no pending claim', () => {
    expectRejected(
      transition('AT_HUB', validEvent('claim_funding_expired'), ctxForState('AT_HUB')),
      'guard_failed',
    );
  });
});

describe('recipient_claimed_pickup', () => {
  const ctx = ctxForState('CLAIMED');

  it('settles the claim: recipient collects pool + Π_v, hub collects Π_h, bond back, DELIVERED', () => {
    const result = transition('CLAIMED', validEvent('recipient_claimed_pickup'), ctx);
    expectOk(result);
    expect(result.nextState).toBe('DELIVERED');
    expect(result.effects).toEqual([
      { kind: 'release_conditional_payment', paymentId: IDS.claimPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'claim_payment_released',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -CLAIM_PAYMENT_MSAT },
          { ownerType: 'user', ownerId: IDS.claimant, accountKind: 'external_wallet', amountMsat: CLAIM_PAYMENT_MSAT },
        ],
      },
      { kind: 'release_conditional_payment', paymentId: IDS.claimHubBonus },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_released',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'user', ownerId: IDS.originHubUser, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
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
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
      {
        kind: 'append_custody_event',
        type: 'recipient_claimed',
        actorUserId: IDS.originHubUser,
        legId: null,
        hubStayId: IDS.originStay,
        payload: { claimId: IDS.claim, claimTokenVerified: true },
      },
      { kind: 'queue_email', to: 'sender', template: 'parcel_delivered', payload: {} },
    ]);
  });

  it('guard: the claim token must be verified at the counter', () => {
    expectRejected(
      transition('CLAIMED', { type: 'recipient_claimed_pickup', claimTokenVerified: false }, ctx),
      'guard_failed',
    );
  });

  it('guard: the claim must reference the current hub stay', () => {
    const claim = { ...pendingClaim(), hubStayId: IDS.arrivalStay };
    expectRejected(
      transition('CLAIMED', validEvent('recipient_claimed_pickup'), { ...ctx, pendingClaim: claim }),
      'guard_failed',
    );
  });
});

describe('claim interactions with the rest of the protocol (ADR-016)', () => {
  const pendingClaimCtx = { ...ctxForState('AT_HUB'), pendingClaim: pendingClaim() };

  it('leg_request is rejected while a claim is pending: the parcel left the board', () => {
    expectRejected(transition('AT_HUB', validEvent('leg_request'), pendingClaimCtx), 'guard_failed');
  });

  it('boost, reroute and cancel are rejected while a claim is pending', () => {
    expectRejected(transition('AT_HUB', validEvent('boost'), pendingClaimCtx), 'guard_failed');
    expectRejected(transition('AT_HUB', validEvent('reroute'), pendingClaimCtx), 'guard_failed');
    expectRejected(transition('AT_HUB', { type: 'cancel' }, pendingClaimCtx), 'guard_failed');
  });

  it('boost, reroute and cancel are illegal in CLAIMED', () => {
    const ctx = ctxForState('CLAIMED');
    expectRejected(transition('CLAIMED', validEvent('boost'), ctx), 'illegal_event');
    expectRejected(transition('CLAIMED', validEvent('reroute'), ctx), 'illegal_event');
    expectRejected(transition('CLAIMED', { type: 'cancel' }, ctx), 'illegal_event');
  });

  it('handoff_reject at the claimed pickup: documentary, nothing moves', () => {
    const ctx = ctxForState('CLAIMED');
    const event = { ...validEvent('handoff_reject'), stage: 'recipient_pickup' } as ShipmentEvent;
    const result = transition('CLAIMED', event, ctx);
    expectOk(result);
    expect(result.nextState).toBe('CLAIMED');
    expect(result.effects.filter((e) => e.kind !== 'append_custody_event' && e.kind !== 'queue_email')).toEqual([]);
  });

  it('storage_expiry with a claim pending funding: holds dissolve without entries, window disarmed', () => {
    const result = transition('AT_HUB', validEvent('storage_expiry'), pendingClaimCtx);
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.claimPayment },
      { kind: 'refund_conditional_payment', paymentId: IDS.claimHubBonus },
      { kind: 'cancel_timeout', timeout: 'claim_funding', refId: IDS.claim },
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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

  it('storage_expiry from CLAIMED: the held claim commitments return to the sender', () => {
    const result = transition('CLAIMED', validEvent('storage_expiry'), ctxForState('CLAIMED'));
    expectOk(result);
    expect(result.nextState).toBe('FORFEITED');
    expect(result.effects).toEqual([
      { kind: 'refund_conditional_payment', paymentId: IDS.claimPayment },
      {
        kind: 'post_ledger_entry',
        eventType: 'claim_payment_refunded',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -CLAIM_PAYMENT_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: CLAIM_PAYMENT_MSAT },
        ],
      },
      { kind: 'refund_conditional_payment', paymentId: IDS.claimHubBonus },
      {
        kind: 'post_ledger_entry',
        eventType: 'finalization_bonus_refunded',
        ref: { type: 'claim', id: IDS.claim },
        postings: [
          { ownerType: 'shipment', ownerId: IDS.shipment, accountKind: 'commitment', amountMsat: -HUB_BONUS_MSAT },
          { ownerType: 'user', ownerId: IDS.sender, accountKind: 'external_wallet', amountMsat: HUB_BONUS_MSAT },
        ],
      },
      { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: IDS.originStay },
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
});

// ---------------------------------------------------------------------------
// The full state × event matrix: everything not explicitly legal is rejected.

const LEGAL: Record<string, ShipmentEventType[]> = {
  'null': ['create'],
  DRAFT: ['origin_hub_accept', 'cancel'],
  AWAITING_DROPOFF: ['origin_checkin', 'cancel', 'bond_renew'],
  // leg_funded / leg_funding_expired are state-legal in AT_HUB but need a
  // pending leg (claim_funded / claim_funding_expired a pending claim, the
  // deposit_* answers a pending request): with the bare AT_HUB fixture they
  // fail on the guard instead.
  AT_HUB: [
    'leg_request',
    'deposit_accept',
    'deposit_reject',
    'deposit_request_expired',
    'deposit_request_cancel',
    'leg_funded',
    'leg_funding_expired',
    'recipient_claim',
    'claim_funded',
    'claim_funding_expired',
    'boost',
    'reroute',
    'cancel',
    'storage_expiry',
    'bond_renew',
  ],
  LEG_BOOKED: ['pickup_checkout', 'pickup_timeout', 'handoff_reject', 'bond_renew'],
  IN_TRANSIT: ['leg_checkin', 'leg_return', 'transit_timeout', 'handoff_reject'],
  AWAITING_PICKUP: ['recipient_pickup', 'reroute', 'boost', 'storage_expiry', 'handoff_reject', 'bond_renew'],
  CLAIMED: ['recipient_claimed_pickup', 'storage_expiry', 'handoff_reject', 'bond_renew'],
  DELIVERED: [],
  CANCELLED: [],
  FORFEITED: [],
  LOST: [],
};

const ALL_EVENT_TYPES: ShipmentEventType[] = [
  'create',
  'origin_hub_accept',
  'origin_checkin',
  'leg_request',
  'deposit_accept',
  'deposit_reject',
  'deposit_request_expired',
  'deposit_request_cancel',
  'leg_funded',
  'leg_funding_expired',
  'pickup_checkout',
  'pickup_timeout',
  'leg_checkin',
  'leg_return',
  'recipient_pickup',
  'recipient_claim',
  'claim_funded',
  'claim_funding_expired',
  'recipient_claimed_pickup',
  'handoff_reject',
  'storage_expiry',
  'transit_timeout',
  'boost',
  'reroute',
  'cancel',
  'bond_renew',
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
        if (state === 'AT_HUB' && (eventType === 'claim_funded' || eventType === 'claim_funding_expired')) {
          ctx = { ...ctx, pendingClaim: pendingClaim() };
        }
        if (
          state === 'AT_HUB' &&
          ['deposit_accept', 'deposit_reject', 'deposit_request_expired', 'deposit_request_cancel'].includes(
            eventType,
          )
        ) {
          ctx = { ...ctx, pendingLegRequest: pendingRequest() };
        }
        cases.push([state, eventType, ctx]);
      }
    }
    const stageFor: Partial<Record<string, 'pickup_checkout' | 'hub_checkin' | 'recipient_pickup'>> = {
      LEG_BOOKED: 'pickup_checkout',
      IN_TRANSIT: 'hub_checkin',
      AWAITING_PICKUP: 'recipient_pickup',
      CLAIMED: 'recipient_pickup',
    };
    for (const [state, eventType, ctx] of cases) {
      let event = validEvent(eventType);
      if (event.type === 'handoff_reject' && state !== null) {
        event = { ...event, stage: stageFor[state]! };
      }
      if (event.type === 'bond_renew' && state === 'AWAITING_PICKUP') {
        // The AWAITING_PICKUP fixture's current stay is the arrival one.
        event = { ...event, hubStayId: IDS.arrivalStay };
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
      transition('AT_HUB', validEvent('claim_funded'), { ...ctxForState('AT_HUB'), pendingClaim: pendingClaim() }),
      transition('CLAIMED', validEvent('recipient_claimed_pickup'), ctxForState('CLAIMED')),
      transition('CLAIMED', validEvent('storage_expiry'), ctxForState('CLAIMED')),
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
