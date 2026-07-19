// Property tests: random walks of VALID events through the machine, with a
// mock world that executes every effect the way the API would (deterministic:
// fixed-seed PRNG). They pin down the §5 invariants the docs ask tests to
// hold, over sequences no hand-written case would think of:
//
//   1. From AT_HUB on there is always exactly one designated custodian and
//      its custody bond is HELD (invariant 4); the number of held custody
//      bonds per state is exactly the protocol's (1 / 3 / 2 / 1).
//   2. Money moves only through the prescribed events: documentary events
//      (boost, reroute, handoff_reject, create, origin_checkin) never carry
//      payment or ledger effects; releases only ever hit held payments; no
//      payment is resolved twice (invariant 2: settle or cancel, never both).
//   3. Every ledger entry sums to zero and can only name user wallets or the
//      shipment's commitment bucket — the platform cannot appear (invariant 1).
//   4. Terminal states are terminal: no outstanding hold, no armed timer,
//      every further event rejected.
//   5. The custody chain built along the walk verifies; one event per
//      transition.

import { describe, expect, it } from 'vitest';
import type { ShipmentContext, ShipmentEffect, ShipmentEvent, ShipmentState } from '@mercurio/shared';
import { custodyEventHash, verifyCustodyChain } from './custody-chain.js';
import { transition } from './state-machine.js';
import { BOND_MSAT, OFFER_MSAT, T0, baseCtx } from './fixtures.js';

/** mulberry32 — tiny deterministic PRNG; quality is irrelevant, determinism is not. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rand: () => number, min: number, max: number): number =>
  min + Math.floor(rand() * (max - min + 1));

function pickWeighted<T>(rand: () => number, options: [T, number][]): T {
  const total = options.reduce((acc, [, w]) => acc + w, 0);
  let roll = rand() * total;
  for (const [value, weight] of options) {
    roll -= weight;
    if (roll <= 0) return value;
  }
  return options[options.length - 1]![0];
}

// ---------------------------------------------------------------------------
// Mock world: executes effects exactly as strictly as the API would.

type PaymentState = 'created' | 'held' | 'settled' | 'cancelled';

interface MockPayment {
  id: string;
  purpose: 'leg_payment' | 'custody_bond' | 'finalization_bonus' | 'claim_payment';
  payerId: string;
  payeeId: string;
  amountMsat: bigint;
  ref: { type: string; id: string };
  state: PaymentState;
}

class World {
  payments = new Map<string, MockPayment>();
  timers = new Map<string, string>(); // `${kind}:${refId}` → at
  chain: {
    shipmentId: string;
    type: string;
    actorUserId: string | null;
    legId: string | null;
    hubStayId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
    prevEventHash: string | null;
    hash: string;
  }[] = [];
  emails: string[] = [];
  instantPayments: { payerId: string; payeeId: string; amountMsat: bigint }[] = [];
  ledgerEntries: { eventType: string; postings: { ownerType: string; ownerId: string; accountKind: string; amountMsat: bigint }[] }[] = [];
  private nextPaymentId = 1;
  private seq = 0;

  execute(shipmentId: string, effects: ShipmentEffect[]): void {
    for (const effect of effects) {
      switch (effect.kind) {
        case 'create_conditional_payment': {
          const id = `cp-${this.nextPaymentId++}`;
          this.payments.set(id, {
            id,
            purpose: effect.purpose,
            payerId: effect.payerId,
            payeeId: effect.payeeId,
            amountMsat: effect.amountMsat,
            ref: effect.ref,
            state: 'created',
          });
          break;
        }
        case 'release_conditional_payment': {
          const payment = this.payments.get(effect.paymentId);
          if (!payment) throw new Error(`release of unknown payment ${effect.paymentId}`);
          // A preimage can be revealed only for a hold that is actually held:
          // releasing an unheld or already-resolved payment is a machine bug.
          if (payment.state !== 'held') {
            throw new Error(`release of ${effect.paymentId} in state ${payment.state}`);
          }
          payment.state = 'settled';
          break;
        }
        case 'refund_conditional_payment': {
          const payment = this.payments.get(effect.paymentId);
          if (!payment) throw new Error(`refund of unknown payment ${effect.paymentId}`);
          if (payment.state !== 'created' && payment.state !== 'held') {
            throw new Error(`refund of ${effect.paymentId} in state ${payment.state} (double resolution)`);
          }
          payment.state = 'cancelled';
          break;
        }
        case 'request_instant_payment': {
          if (effect.amountMsat <= 0n) throw new Error('instant payment must be > 0 (zero fees are skipped)');
          this.instantPayments.push({ payerId: effect.payerId, payeeId: effect.payeeId, amountMsat: effect.amountMsat });
          break;
        }
        case 'post_ledger_entry': {
          const sum = effect.postings.reduce((acc, p) => acc + p.amountMsat, 0n);
          if (sum !== 0n) throw new Error(`unbalanced ledger entry ${effect.eventType}: ${sum}`);
          for (const posting of effect.postings) {
            const validPair =
              (posting.accountKind === 'commitment' && posting.ownerType === 'shipment') ||
              (posting.accountKind === 'external_wallet' && posting.ownerType === 'user');
            if (!validPair) {
              throw new Error(`posting names a forbidden account: ${posting.accountKind}/${posting.ownerType}`);
            }
          }
          this.ledgerEntries.push({ eventType: effect.eventType, postings: effect.postings });
          // A *_held entry marks the moment the wallet reported the hold as
          // held: flip the referenced payment, like the API's wallet-event
          // handler would.
          if (effect.eventType.endsWith('_held')) {
            const purpose =
              effect.eventType === 'leg_payment_held'
                ? 'leg_payment'
                : effect.eventType === 'claim_payment_held'
                  ? 'claim_payment'
                  : effect.eventType === 'finalization_bonus_held'
                    ? 'finalization_bonus'
                    : 'custody_bond';
            const match = [...this.payments.values()].find(
              (p) =>
                p.state === 'created' &&
                p.purpose === purpose &&
                p.ref.type === effect.ref.type &&
                p.ref.id === effect.ref.id,
            );
            if (!match) throw new Error(`held entry ${effect.eventType} matches no created payment`);
            match.state = 'held';
          }
          break;
        }
        case 'append_custody_event': {
          const prev = this.chain[this.chain.length - 1]?.hash ?? null;
          const input = {
            shipmentId,
            type: effect.type,
            actorUserId: effect.actorUserId,
            legId: effect.legId,
            hubStayId: effect.hubStayId,
            payload: effect.payload,
            createdAt: new Date(T0 + this.seq++ * 1000).toISOString(),
          };
          this.chain.push({ ...input, prevEventHash: prev, hash: custodyEventHash(input, prev) });
          break;
        }
        case 'queue_email':
          this.emails.push(`${effect.to}:${effect.template}`);
          break;
        case 'schedule_timeout': {
          const key = `${effect.timeout}:${effect.refId}`;
          if (this.timers.has(key)) throw new Error(`timer ${key} armed twice`);
          this.timers.set(key, effect.at);
          break;
        }
        case 'cancel_timeout': {
          const key = `${effect.timeout}:${effect.refId}`;
          if (!this.timers.has(key)) throw new Error(`cancel of unarmed timer ${key}`);
          this.timers.delete(key);
          break;
        }
        case 'rotate_pickup_otp':
        case 'rotate_claim_token':
          break;
      }
    }
  }

  /** Consume a fired timer (the worker does this implicitly by firing it). */
  fire(kind: string, refId: string): void {
    const key = `${kind}:${refId}`;
    if (!this.timers.has(key)) throw new Error(`firing unarmed timer ${key}`);
    this.timers.delete(key);
  }

  paymentByRef(purpose: MockPayment['purpose'], refType: string, refId: string): MockPayment {
    const match = [...this.payments.values()].find(
      (p) => p.purpose === purpose && p.ref.type === refType && p.ref.id === refId,
    );
    if (!match) throw new Error(`no ${purpose} payment for ${refType}:${refId}`);
    return match;
  }

  heldCustodyBonds(): MockPayment[] {
    return [...this.payments.values()].filter((p) => p.purpose === 'custody_bond' && p.state === 'held');
  }

  outstanding(): MockPayment[] {
    return [...this.payments.values()].filter((p) => p.state === 'created' || p.state === 'held');
  }
}

// ---------------------------------------------------------------------------
// The walker: drives (state, ctx, world) with random valid events.

const HUBS = [
  { hubId: 'hub-0', userId: 'user-hub-0' },
  { hubId: 'hub-1', userId: 'user-hub-1' },
  { hubId: 'hub-2', userId: 'user-hub-2' },
  { hubId: 'hub-3', userId: 'user-hub-3' },
];

/** Events that must never move money (documentary/administrative only).
 *  `reroute` left this set with ADR-014: rerouting away from the delivery
 *  state cancels the pending Π_h hold — asserted precisely in the walk.
 *  The whole deposit-request phase is money-free by design (ADR-029): the
 *  request and every dissolution of it belong here. */
const NO_MONEY_EVENTS = new Set([
  'create',
  'origin_checkin',
  'boost',
  'handoff_reject',
  'leg_request',
  'deposit_reject',
  'deposit_request_expired',
  'deposit_request_cancel',
]);

const MONEY_KINDS = new Set([
  'create_conditional_payment',
  'release_conditional_payment',
  'refund_conditional_payment',
  'request_instant_payment',
  'post_ledger_entry',
]);

interface Walker {
  state: ShipmentState | null;
  ctx: ShipmentContext;
  world: World;
  clock: number; // minutes since T0, only ever increases
  nextId: number;
}

const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

function randomPricing(
  rand: () => number,
  isFinal: boolean,
): { grossMsat: bigint; depHubFeeMsat: bigint; arrHubFeeMsat: bigint; netMsat: bigint; finalizationBonusMsat: bigint } {
  const gross = BigInt(randInt(rand, 3, 4000)) * 1000n; // sat-aligned
  const dep = (gross * BigInt(randInt(rand, 0, 3000))) / 10_000n;
  const arr = (gross * BigInt(randInt(rand, 0, 3000))) / 10_000n;
  // Only the final leg may carry the carrier share; sometimes 0 even there
  // (consumed quota after a post-arrival reroute, ADR-014 §5).
  const bonus = isFinal && rand() < 0.8 ? BigInt(randInt(rand, 1, 400)) * 1000n : 0n;
  return {
    grossMsat: gross,
    depHubFeeMsat: dep,
    arrHubFeeMsat: arr,
    netMsat: gross - dep - arr,
    finalizationBonusMsat: bonus,
  };
}

/** Which event types are feasible right now, with generator weights. */
function feasibleEvents(walker: Walker): [string, number][] {
  const { state, ctx } = walker;
  if (state === null) return [['create', 1]];
  switch (state) {
    case 'DRAFT':
      return [
        ['origin_hub_accept', 6],
        ['cancel', 1],
      ];
    case 'AWAITING_DROPOFF':
      return [
        ['origin_checkin', 6],
        ['cancel', 1],
      ];
    case 'AT_HUB': {
      if (ctx.pendingLegRequest !== null) {
        // Board-exclusive (ADR-029): only the hub's answer, the carrier's
        // withdrawal, the response clock and the storage clock remain valid.
        return [
          ['deposit_accept', 6],
          ['deposit_reject', 1],
          ['deposit_request_expired', 1],
          ['deposit_request_cancel', 1],
          ['storage_expiry', 1],
        ];
      }
      if (ctx.leg !== null) {
        return [
          ['leg_funded', 6],
          ['leg_funding_expired', 1],
          ['boost', 1],
          ['storage_expiry', 1],
        ];
      }
      if (ctx.pendingClaim !== null) {
        // Boost/reroute/cancel/leg_request are all rejected here (ADR-016):
        // only the claim's own outcomes and the storage clock remain valid.
        return [
          ['claim_funded', 6],
          ['claim_funding_expired', 1],
          ['storage_expiry', 1],
        ];
      }
      const events: [string, number][] = [
        ['leg_request', 8],
        ['recipient_claim', 2],
        ['boost', 1],
        ['reroute', 1],
        ['storage_expiry', 1],
      ];
      if (ctx.currentHubStay!.hubId === ctx.originHubId) events.push(['cancel', 1]);
      return events;
    }
    case 'LEG_BOOKED':
      return [
        ['pickup_checkout', 8],
        ['pickup_timeout', 1],
        ['handoff_reject', 1],
      ];
    case 'IN_TRANSIT':
      return [
        ['leg_checkin', 8],
        ['leg_return', 1],
        ['transit_timeout', 1],
        ['handoff_reject', 1],
      ];
    case 'AWAITING_PICKUP':
      return [
        ['recipient_pickup', 6],
        ['reroute', 1],
        ['boost', 1],
        ['storage_expiry', 1],
        ['handoff_reject', 1],
      ];
    case 'CLAIMED':
      return [
        ['recipient_claimed_pickup', 6],
        ['storage_expiry', 1],
        ['handoff_reject', 1],
      ];
    default:
      return [];
  }
}

/** Build a guard-satisfying event of the given type, advancing the clock as
 *  needed (timeouts jump the clock to the relevant deadline). */
function buildEvent(walker: Walker, rand: () => number, type: string): ShipmentEvent {
  const { ctx } = walker;
  const mint = (prefix: string): string => `${prefix}-${walker.nextId++}`;
  switch (type) {
    case 'create':
      return { type };
    case 'origin_hub_accept':
      return { type, hubStayId: mint('stay'), hubWalletConnected: true };
    case 'origin_checkin':
      return { type, photoSha256: [mint('ph')], storageDeadlineAt: iso(walker.clock + randInt(rand, 60, 2000)) };
    case 'leg_request': {
      const current = ctx.currentHubStay!.hubId;
      const candidates = HUBS.filter((h) => h.hubId !== current);
      // Bias toward finishing: half the time aim straight at the destination.
      const dest = HUBS.find((h) => h.hubId === ctx.destHubId)!;
      const toHub = rand() < 0.5 && dest.hubId !== current ? dest : candidates[randInt(rand, 0, candidates.length - 1)]!;
      const isFinal = toHub.hubId === ctx.destHubId;
      return {
        type,
        legId: mint('leg'),
        carrierId: `user-carrier-${randInt(rand, 0, 2)}`,
        carrierWalletConnected: true,
        carrierTripActive: true,
        toHubId: toHub.hubId,
        toHubUserId: toHub.userId,
        arrivalHubWalletConnected: true,
        pricing: randomPricing(rand, isFinal),
        // Zero sometimes: the share may floor to nothing (then no 4th hold).
        finalizationHubBonusMsat: isFinal && rand() < 0.8 ? BigInt(randInt(rand, 1, 300)) * 1000n : 0n,
        responseDeadlineAt: iso(walker.clock + 30),
      };
    }
    case 'deposit_accept':
      return {
        type,
        now: iso(walker.clock),
        arrivalHubStayId: mint('stay'),
        arrivalHubWalletConnected: true,
        fundingDeadlineAt: iso(walker.clock + 60),
      };
    case 'deposit_reject':
      return {
        type,
        rejectedById: ctx.pendingLegRequest!.toHubUserId,
        reason: 'no room on the shelf',
      };
    case 'deposit_request_expired': {
      walker.clock = (Date.parse(ctx.pendingLegRequest!.responseDeadlineAt) - T0) / 60_000 + 1;
      return { type, now: iso(walker.clock) };
    }
    case 'deposit_request_cancel':
      return { type };
    case 'leg_funded':
      return { type, now: iso(walker.clock), pickupDeadlineAt: iso(walker.clock + randInt(rand, 30, 120)) };
    case 'leg_funding_expired': {
      walker.clock = (Date.parse(ctx.leg!.fundingDeadlineAt) - T0) / 60_000 + 1;
      return { type, now: iso(walker.clock) };
    }
    case 'pickup_checkout':
      return {
        type,
        now: iso(walker.clock),
        hubConfirmed: true,
        carrierConfirmed: true,
        photoSha256: [mint('ph')],
        transitDeadlineAt: iso(walker.clock + randInt(rand, 60, 900)),
      };
    case 'pickup_timeout': {
      walker.clock = (Date.parse(ctx.leg!.pickupDeadlineAt!) - T0) / 60_000 + 1;
      return { type, now: iso(walker.clock) };
    }
    case 'leg_checkin':
      return {
        type,
        now: iso(walker.clock),
        hubId: ctx.leg!.toHubId,
        integrityConfirmed: true,
        photoSha256: [mint('ph')],
        storageDeadlineAt: iso(walker.clock + randInt(rand, 60, 2000)),
      };
    case 'leg_return':
      return {
        type,
        now: iso(walker.clock),
        hubId: ctx.leg!.fromHubId,
        returnHubStayId: mint('stay'),
        photoSha256: [mint('ph')],
        storageDeadlineAt: iso(walker.clock + randInt(rand, 60, 2000)),
      };
    case 'recipient_pickup':
      return { type, otpVerified: true };
    case 'recipient_claim':
      return {
        type,
        claimId: mint('claim'),
        claimantId: 'user-recipient',
        claimantWalletConnected: true,
        claimTokenVerified: true,
        claimPaymentMsat: BigInt(randInt(rand, 1, 4000)) * 1000n,
        // Zero sometimes: the accrued Π_h may floor to nothing (then no hold).
        hubBonusMsat: rand() < 0.8 ? BigInt(randInt(rand, 1, 300)) * 1000n : 0n,
        fundingDeadlineAt: iso(walker.clock + 60),
      };
    case 'claim_funded':
      return { type, now: iso(walker.clock) };
    case 'claim_funding_expired': {
      walker.clock = (Date.parse(ctx.pendingClaim!.fundingDeadlineAt) - T0) / 60_000 + 1;
      return { type, now: iso(walker.clock) };
    }
    case 'recipient_claimed_pickup':
      return { type, claimTokenVerified: true };
    case 'handoff_reject': {
      const stage =
        walker.state === 'LEG_BOOKED' ? 'pickup_checkout' : walker.state === 'IN_TRANSIT' ? 'hub_checkin' : 'recipient_pickup';
      return { type, stage, rejectedById: 'user-somebody', reason: 'suspicious parcel', photoSha256: [mint('ph')] };
    }
    case 'storage_expiry': {
      walker.clock = Math.max(walker.clock, (Date.parse(ctx.currentHubStay!.storageDeadlineAt) - T0) / 60_000 + 1);
      return { type, now: iso(walker.clock) };
    }
    case 'transit_timeout': {
      walker.clock = (Date.parse(ctx.leg!.transitDeadlineAt!) - T0) / 60_000 + 1;
      return { type, now: iso(walker.clock) };
    }
    case 'boost':
      return { type, amountMsat: BigInt(randInt(rand, 1, 2000)) * 1000n, atRemainingKm: randInt(rand, 1, 100) };
    case 'reroute': {
      const current = ctx.currentHubStay!.hubId;
      if (walker.state === 'AWAITING_PICKUP' && rand() < 0.5) {
        // Recipient-only change at the destination.
        return { type, newDestHubId: null, newDestHubUserId: null, newRecipientEmail: 'new@x.it', newRemainingKm: 1 };
      }
      const candidates = HUBS.filter((h) => h.hubId !== current);
      const dest = candidates[randInt(rand, 0, candidates.length - 1)]!;
      return {
        type,
        newDestHubId: dest.hubId,
        newDestHubUserId: dest.userId,
        newRecipientEmail: rand() < 0.3 ? 'other@x.it' : null,
        newRemainingKm: randInt(rand, 1, 200),
      };
    }
    case 'cancel':
      return { type };
    default:
      throw new Error(`no generator for ${type}`);
  }
}

/** Mirror the API: persist the transition's outcome into ctx/state/world. */
function apply(walker: Walker, type: string, event: ShipmentEvent, nextState: ShipmentState, effects: ShipmentEffect[]): void {
  const { ctx, world } = walker;
  // Fired timers are consumed by the worker before the transition runs.
  if (type === 'leg_funding_expired') world.fire('leg_funding', ctx.leg!.legId);
  if (type === 'pickup_timeout') world.fire('pickup', ctx.leg!.legId);
  if (type === 'transit_timeout') world.fire('transit', ctx.leg!.legId);
  if (type === 'storage_expiry') world.fire('storage', ctx.currentHubStay!.hubStayId);
  if (type === 'claim_funding_expired') world.fire('claim_funding', ctx.pendingClaim!.claimId);
  if (type === 'deposit_request_expired') world.fire('deposit_response', ctx.pendingLegRequest!.legId);
  world.execute(ctx.shipmentId, effects);

  switch (type) {
    case 'origin_hub_accept': {
      const stayId = (event as Extract<ShipmentEvent, { type: 'origin_hub_accept' }>).hubStayId;
      ctx.currentHubStay = {
        hubStayId: stayId,
        hubId: ctx.originHubId,
        hubUserId: ctx.originHubUserId,
        bondPaymentId: world.paymentByRef('custody_bond', 'hub_stay', stayId).id,
        storageDeadlineAt: iso(walker.clock + 100_000), // set for real at check-in
      };
      break;
    }
    case 'origin_checkin':
      ctx.currentHubStay!.storageDeadlineAt = (event as Extract<ShipmentEvent, { type: 'origin_checkin' }>).storageDeadlineAt;
      break;
    case 'leg_request': {
      const e = event as Extract<ShipmentEvent, { type: 'leg_request' }>;
      // Money-free (ADR-029): only the pending request enters the context.
      ctx.pendingLegRequest = {
        legId: e.legId,
        carrierId: e.carrierId,
        fromHubId: ctx.currentHubStay!.hubId,
        fromHubUserId: ctx.currentHubStay!.hubUserId,
        toHubId: e.toHubId,
        toHubUserId: e.toHubUserId,
        pricing: e.pricing,
        finalizationHubBonusMsat: e.finalizationHubBonusMsat,
        responseDeadlineAt: e.responseDeadlineAt,
      };
      break;
    }
    case 'deposit_accept': {
      const e = event as Extract<ShipmentEvent, { type: 'deposit_accept' }>;
      const req = ctx.pendingLegRequest!;
      ctx.leg = {
        legId: req.legId,
        carrierId: req.carrierId,
        fromHubId: req.fromHubId,
        fromHubUserId: req.fromHubUserId,
        toHubId: req.toHubId,
        toHubUserId: req.toHubUserId,
        arrivalHubStayId: e.arrivalHubStayId,
        pricing: req.pricing,
        legPaymentId: world.paymentByRef('leg_payment', 'leg', req.legId).id,
        carrierBondId: world.paymentByRef('custody_bond', 'leg', req.legId).id,
        arrivalHubBondId: world.paymentByRef('custody_bond', 'hub_stay', e.arrivalHubStayId).id,
        fundingDeadlineAt: e.fundingDeadlineAt,
        pickupDeadlineAt: null,
        transitDeadlineAt: null,
      };
      // The fourth hold exists only when the final leg froze a hub share.
      ctx.finalizationBonusHold =
        req.finalizationHubBonusMsat > 0n
          ? {
              paymentId: world.paymentByRef('finalization_bonus', 'hub_stay', e.arrivalHubStayId).id,
              amountMsat: req.finalizationHubBonusMsat,
            }
          : null;
      ctx.pendingLegRequest = null;
      break;
    }
    case 'deposit_reject':
    case 'deposit_request_expired':
    case 'deposit_request_cancel':
      ctx.pendingLegRequest = null;
      break;
    case 'leg_funded':
      ctx.leg!.pickupDeadlineAt = (event as Extract<ShipmentEvent, { type: 'leg_funded' }>).pickupDeadlineAt;
      break;
    case 'leg_funding_expired':
    case 'pickup_timeout':
      ctx.leg = null;
      ctx.finalizationBonusHold = null;
      break;
    case 'pickup_checkout':
      ctx.leg!.transitDeadlineAt = (event as Extract<ShipmentEvent, { type: 'pickup_checkout' }>).transitDeadlineAt;
      ctx.currentHubStay = null;
      break;
    case 'leg_checkin': {
      const e = event as Extract<ShipmentEvent, { type: 'leg_checkin' }>;
      ctx.currentHubStay = {
        hubStayId: ctx.leg!.arrivalHubStayId,
        hubId: ctx.leg!.toHubId,
        hubUserId: ctx.leg!.toHubUserId,
        bondPaymentId: ctx.leg!.arrivalHubBondId,
        storageDeadlineAt: e.storageDeadlineAt,
      };
      ctx.leg = null;
      break;
    }
    case 'leg_return': {
      const e = event as Extract<ShipmentEvent, { type: 'leg_return' }>;
      ctx.currentHubStay = {
        hubStayId: e.returnHubStayId,
        hubId: ctx.leg!.fromHubId,
        hubUserId: ctx.leg!.fromHubUserId,
        bondPaymentId: world.paymentByRef('custody_bond', 'hub_stay', e.returnHubStayId).id,
        storageDeadlineAt: e.storageDeadlineAt,
      };
      ctx.leg = null;
      ctx.finalizationBonusHold = null;
      break;
    }
    case 'transit_timeout':
      ctx.finalizationBonusHold = null;
      break;
    case 'recipient_claim': {
      const e = event as Extract<ShipmentEvent, { type: 'recipient_claim' }>;
      ctx.pendingClaim = {
        claimId: e.claimId,
        claimantId: e.claimantId,
        hubStayId: ctx.currentHubStay!.hubStayId,
        claimPaymentMsat: e.claimPaymentMsat,
        hubBonusMsat: e.hubBonusMsat,
        claimPaymentId: world.paymentByRef('claim_payment', 'claim', e.claimId).id,
        hubBonusPaymentId:
          e.hubBonusMsat > 0n
            ? world.paymentByRef('finalization_bonus', 'claim', e.claimId).id
            : null,
        fundingDeadlineAt: e.fundingDeadlineAt,
      };
      break;
    }
    case 'claim_funding_expired':
      ctx.pendingClaim = null;
      break;
    case 'recipient_claimed_pickup':
      ctx.pendingClaim = null;
      break;
    case 'reroute': {
      const e = event as Extract<ShipmentEvent, { type: 'reroute' }>;
      if (e.newDestHubId !== null) {
        ctx.destHubId = e.newDestHubId;
        // Rerouting away from the delivery state cancelled the Π_h hold.
        ctx.finalizationBonusHold = null;
      }
      break;
    }
    default:
      break;
  }
  walker.state = nextState;
  walker.clock += 1;
}

/** The designated custodian's bond payment id for the current state, or null
 *  before custody starts (invariant 4 applies from AT_HUB on). */
function custodianBondId(walker: Walker): string | null {
  switch (walker.state) {
    case 'AT_HUB':
    case 'LEG_BOOKED':
    case 'AWAITING_PICKUP':
    case 'CLAIMED':
      return walker.ctx.currentHubStay!.bondPaymentId;
    case 'IN_TRANSIT':
      return walker.ctx.leg!.carrierBondId;
    default:
      return null;
  }
}

/** Exact number of held custody bonds the protocol prescribes per state. */
function expectedHeldBonds(walker: Walker): number | null {
  switch (walker.state) {
    case 'AT_HUB':
      return 1; // pending-leg holds are not held until leg_funded
    case 'LEG_BOOKED':
      return 3; // ceding hub + carrier + arrival hub
    case 'IN_TRANSIT':
      return 2; // carrier + arrival hub
    case 'AWAITING_PICKUP':
      return 1; // destination hub
    case 'CLAIMED':
      return 1; // the hub the parcel already sits at (custody never moved)
    default:
      return null;
  }
}

const ALL_EVENT_TYPES = [
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
] as const;

describe('property: random valid walks preserve the §5 invariants', () => {
  it('300 walks × ≤ 60 steps: custody, money and terminality all hold', () => {
    const rand = mulberry32(0xc0ffee);
    const reachedTerminals = new Set<string>();

    for (let walk = 0; walk < 300; walk += 1) {
      const walker: Walker = {
        state: null,
        ctx: {
          ...baseCtx(),
          originHubId: HUBS[0]!.hubId,
          originHubUserId: HUBS[0]!.userId,
          destHubId: HUBS[randInt(rand, 1, 3)]!.hubId,
          offerMsat: OFFER_MSAT,
          custodyBondMsat: BOND_MSAT,
        },
        world: new World(),
        clock: 0,
        nextId: 1,
      };

      for (let step = 0; step < 60; step += 1) {
        const feasible = feasibleEvents(walker);
        if (feasible.length === 0) break; // terminal
        const type = pickWeighted(rand, feasible);
        const event = buildEvent(walker, rand, type);
        const result = transition(walker.state, event, walker.ctx);
        if (!result.ok) {
          throw new Error(
            `walk ${walk} step ${step}: ${type} in ${walker.state} rejected: ${result.error.code} ${result.error.message}`,
          );
        }

        // One custody event per transition, no more, no less.
        const custodyEvents = result.effects.filter((e) => e.kind === 'append_custody_event');
        expect(custodyEvents).toHaveLength(1);

        // Documentary events never move money.
        if (NO_MONEY_EVENTS.has(type)) {
          expect(result.effects.filter((e) => MONEY_KINDS.has(e.kind))).toEqual([]);
        }
        // Reroute moves money in exactly one case: leaving the delivery state
        // cancels the pending Π_h hold (ADR-014 §5) — nothing more, ever.
        if (type === 'reroute') {
          const e = event as Extract<ShipmentEvent, { type: 'reroute' }>;
          const bonusHold = walker.ctx.finalizationBonusHold;
          const money = result.effects.filter((ef) => MONEY_KINDS.has(ef.kind));
          if (walker.state === 'AWAITING_PICKUP' && e.newDestHubId !== null && bonusHold) {
            expect(money).toEqual([
              { kind: 'refund_conditional_payment', paymentId: bonusHold.paymentId },
              expect.objectContaining({ kind: 'post_ledger_entry', eventType: 'finalization_bonus_refunded' }),
            ]);
          } else {
            expect(money).toEqual([]);
          }
        }

        // Executing the effects enforces per-effect discipline (balanced
        // entries, release-only-held, no double resolution, timer hygiene).
        apply(walker, type, event, result.nextState, result.effects);

        // Invariant 4: one designated custodian whose bond is HELD, and the
        // exact number of held custody bonds the protocol prescribes.
        const bondId = custodianBondId(walker);
        if (bondId !== null) {
          expect(walker.world.payments.get(bondId)?.state).toBe('held');
        }
        const expected = expectedHeldBonds(walker);
        if (expected !== null) {
          expect(walker.world.heldCustodyBonds(), `held bonds in ${walker.state}`).toHaveLength(expected);
        }
      }

      if (walker.state !== null && ['DELIVERED', 'CANCELLED', 'FORFEITED', 'LOST'].includes(walker.state)) {
        reachedTerminals.add(walker.state);
        // Invariant 2/7: nothing left in limbo — every hold settled or
        // cancelled, no timer still armed.
        expect(walker.world.outstanding()).toEqual([]);
        expect([...walker.world.timers.keys()]).toEqual([]);
        // Terminal states are terminal: every event is rejected.
        for (const type of ALL_EVENT_TYPES) {
          let probe: ShipmentEvent;
          try {
            probe = buildEvent(walker, rand, type);
          } catch {
            // Generators for leg-bound events need a leg in ctx; a synthetic
            // minimal probe suffices to prove the state rejects the type.
            probe = { type: 'cancel' };
          }
          const result = transition(walker.state, probe, walker.ctx);
          expect(result.ok).toBe(false);
        }
      }

      // The custody chain built along the walk verifies end to end.
      expect(verifyCustodyChain(walker.world.chain)).toEqual({ valid: true });
    }

    // The walk generator actually exercises every terminal outcome.
    expect([...reachedTerminals].sort()).toEqual(['CANCELLED', 'DELIVERED', 'FORFEITED', 'LOST']);
  });

  it('ledger conservation along the walks: shipment commitment balance returns to zero at terminal', () => {
    const rand = mulberry32(0x5eed2);
    for (let walk = 0; walk < 100; walk += 1) {
      const walker: Walker = {
        state: null,
        ctx: {
          ...baseCtx(),
          originHubId: HUBS[0]!.hubId,
          originHubUserId: HUBS[0]!.userId,
          destHubId: HUBS[randInt(rand, 1, 3)]!.hubId,
        },
        world: new World(),
        clock: 0,
        nextId: 1,
      };
      for (let step = 0; step < 60; step += 1) {
        const feasible = feasibleEvents(walker);
        if (feasible.length === 0) break;
        const type = pickWeighted(rand, feasible);
        const event = buildEvent(walker, rand, type);
        const result = transition(walker.state, event, walker.ctx);
        if (!result.ok) throw new Error(`unexpected rejection: ${result.error.message}`);
        apply(walker, type, event, result.nextState, result.effects);
      }
      if (walker.state === null || !['DELIVERED', 'CANCELLED', 'FORFEITED', 'LOST'].includes(walker.state)) continue;
      let commitmentBalance = 0n;
      for (const entry of walker.world.ledgerEntries) {
        for (const posting of entry.postings) {
          if (posting.accountKind === 'commitment') commitmentBalance += posting.amountMsat;
        }
      }
      // Every commitment recognized in the shadow ledger was eventually
      // released or refunded: no msat is parked forever (invariant 7).
      expect(commitmentBalance).toBe(0n);
    }
  });
});
