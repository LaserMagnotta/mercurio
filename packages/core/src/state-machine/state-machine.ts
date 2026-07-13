// Shipment lifecycle state machine (ARCHITECTURE.md §5, ADR-012, ADR-013).
//
// transition(state, event, ctx) is a pure function: no I/O, no clock, no
// randomness. It returns the next state plus a list of DECLARATIVE effects
// (data, never actions) that the API executes in a single DB transaction —
// if any step fails, the transition never happened. This function is the
// ONLY source of money movements in Mercurio: every conditional-payment
// effect is paired with its shadow-ledger journal entry, and every
// transition appends exactly one custody-chain event.
//
// Deliberate implementation choices (documented in ARCHITECTURE.md §5,
// "Precisazioni implementative"):
//  - leg_funding_expired is an explicit event (the "finestra scaduta" arm of
//    table row 5): it cancels the three holds, so it must be a transition.
//    Its refunds carry no journal entries: commitments enter the shadow
//    ledger only at leg_funded — a hold cancelled before booking never
//    became a commitment.
//  - leg_return refunds the arrival hub's bond (its stay never activates)
//    and requires a FRESH bond from the re-accepting departure hub:
//    whoever takes custody posts the bond (§6), and invariant 4 demands a
//    bonded custodian at every instant from AT_HUB on.
//  - transit_timeout also refunds the arrival hub's bond (implied by
//    invariant 2: every hold is either settled or cancelled).
//  - The storage timer is disarmed at leg_funded and re-armed (original
//    deadline) if pickup_timeout puts the parcel back on the board. If
//    storage expires while a leg is still pending funding, the pending
//    holds are cancelled within the same storage_expiry transition.
//  - Timeout events consume their own timer: they emit no cancel_timeout
//    for it (the worker already fired it).
//  - Zero-amount instant payments (a hub configured at 0%) are skipped
//    entirely — no invoice, no journal entry.
//  - Authorization (sessions, QR possession, OTP hash check) happens in the
//    API before calling the machine: guards here validate protocol logic on
//    facts the caller declares (e.g. `otpVerified`, photo hashes).
//
// Finalization bonus (ADR-014): the carrier share Π_v rides INSIDE the final
// leg-payment hold (amount = gross + Π_v, same preimage, same events), while
// the hub share Π_h is a fourth hold sender → destination hub created in the
// final leg's funding window and released only at recipient_pickup. Every
// failure of the final leg — funding expiry, pickup/transit timeout, return,
// storage expiry, reroute away from the destination — cancels the Π_h hold
// together with the others; a zero share simply creates no hold, mirroring
// the zero-fee rule.

import type {
  ActiveLeg,
  FinalizationBonusHold,
  LedgerPosting,
  LedgerRef,
  Msat,
  PaymentRef,
  ShipmentContext,
  ShipmentEffect,
  ShipmentEvent,
  ShipmentEventType,
  ShipmentState,
  TransitionResult,
} from '@mercurio/shared';
import { cancellationCompensation, splitCommitment } from '../economics/economics';

const TERMINAL_STATES: readonly ShipmentState[] = ['DELIVERED', 'CANCELLED', 'FORFEITED', 'LOST'];

export function isTerminalState(state: ShipmentState): boolean {
  return TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Result helpers

function ok(nextState: ShipmentState, effects: ShipmentEffect[]): TransitionResult {
  return { ok: true, nextState, effects };
}

function illegal(state: ShipmentState | null, event: ShipmentEventType, message: string): TransitionResult {
  return { ok: false, error: { code: 'illegal_event', state, event, message } };
}

function guardFailed(
  state: ShipmentState | null,
  event: ShipmentEventType,
  message: string,
): TransitionResult {
  return { ok: false, error: { code: 'guard_failed', state, event, message } };
}

// ---------------------------------------------------------------------------
// Time — ISO 8601 UTC strings compared as epochs; the caller injects `now`.

function epoch(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`invalid ISO timestamp: ${JSON.stringify(iso)}`);
  }
  return ms;
}

/** True when `now` is at or before the deadline (boundary counts as met). */
function withinDeadline(now: string, deadline: string): boolean {
  return epoch(now) <= epoch(deadline);
}

/** True when the deadline is reached or passed (timeouts fire at the boundary). */
function deadlinePassed(now: string, deadline: string): boolean {
  return epoch(now) >= epoch(deadline);
}

// ---------------------------------------------------------------------------
// Ledger posting builders (ADR-010). Every entry sums to zero by construction
// and only ever names user wallets or the shipment's commitment bucket —
// there is no way to express a platform account (invariant 1).

function walletPosting(userId: string, amountMsat: Msat): LedgerPosting {
  return { ownerType: 'user', ownerId: userId, accountKind: 'external_wallet', amountMsat };
}

function commitmentPosting(shipmentId: string, amountMsat: Msat): LedgerPosting {
  return { ownerType: 'shipment', ownerId: shipmentId, accountKind: 'commitment', amountMsat };
}

/** A hold became held: the payer's funds are now committed to the shipment. */
function heldEntry(
  eventType: string,
  ref: LedgerRef,
  payerId: string,
  shipmentId: string,
  amountMsat: Msat,
): ShipmentEffect {
  return {
    kind: 'post_ledger_entry',
    eventType,
    ref,
    postings: [walletPosting(payerId, -amountMsat), commitmentPosting(shipmentId, amountMsat)],
  };
}

/** A hold settled: the payee collected directly from the payer (release/slash). */
function settledEntry(
  eventType: string,
  ref: LedgerRef,
  payeeId: string,
  shipmentId: string,
  amountMsat: Msat,
): ShipmentEffect {
  return {
    kind: 'post_ledger_entry',
    eventType,
    ref,
    postings: [commitmentPosting(shipmentId, -amountMsat), walletPosting(payeeId, amountMsat)],
  };
}

/** A hold was cancelled: the commitment dissolves back to the payer. */
function refundedEntry(
  eventType: string,
  ref: LedgerRef,
  payerId: string,
  shipmentId: string,
  amountMsat: Msat,
): ShipmentEffect {
  return {
    kind: 'post_ledger_entry',
    eventType,
    ref,
    postings: [commitmentPosting(shipmentId, -amountMsat), walletPosting(payerId, amountMsat)],
  };
}

/** An instant payment settled on the spot, wallet to wallet. */
function instantEntry(
  eventType: string,
  ref: LedgerRef,
  payerId: string,
  payeeId: string,
  amountMsat: Msat,
): ShipmentEffect {
  return {
    kind: 'post_ledger_entry',
    eventType,
    ref,
    postings: [walletPosting(payerId, -amountMsat), walletPosting(payeeId, amountMsat)],
  };
}

/** Instant payment + its journal entry; empty when the amount is zero. */
function instantPayment(
  reason: 'dep_hub_fee' | 'arr_hub_fee' | 'cancellation_compensation',
  eventType: string,
  ref: LedgerRef,
  payerId: string,
  payeeId: string,
  amountMsat: Msat,
): ShipmentEffect[] {
  if (amountMsat === 0n) return [];
  return [
    { kind: 'request_instant_payment', payerId, payeeId, amountMsat, reason, ref },
    instantEntry(eventType, ref, payerId, payeeId, amountMsat),
  ];
}

// ---------------------------------------------------------------------------
// Small guards shared by several events

function pricingIsConsistent(pricing: ActiveLeg['pricing']): boolean {
  const { grossMsat, depHubFeeMsat, arrHubFeeMsat, netMsat, finalizationBonusMsat } = pricing;
  return (
    grossMsat > 0n &&
    depHubFeeMsat >= 0n &&
    arrHubFeeMsat >= 0n &&
    netMsat >= 0n &&
    finalizationBonusMsat >= 0n &&
    // The bonus sits OUTSIDE the gross identity: fees never touch it (ADR-014).
    depHubFeeMsat + arrHubFeeMsat + netMsat === grossMsat
  );
}

/** The leg-payment hold binds gross + carrier bonus share (ADR-014): same
 *  hash, same preimage, collected in one piece at the arrival check-in. */
function legHoldAmount(leg: ActiveLeg): Msat {
  return leg.pricing.grossMsat + leg.pricing.finalizationBonusMsat;
}

function legRef(leg: ActiveLeg): PaymentRef {
  return { type: 'leg', id: leg.legId };
}

function stayRef(hubStayId: string): PaymentRef {
  return { type: 'hub_stay', id: hubStayId };
}

/** Cancel the per-leg holds of a leg that never got booked — the three of
 *  ESCROW.md §3 plus, on a final leg, the hub-bonus hold (ADR-014). No
 *  journal entries: commitments enter the shadow ledger only at leg_funded. */
function refundPendingLegHolds(leg: ActiveLeg, bonusHold: FinalizationBonusHold | null): ShipmentEffect[] {
  const effects: ShipmentEffect[] = [
    { kind: 'refund_conditional_payment', paymentId: leg.legPaymentId },
    { kind: 'refund_conditional_payment', paymentId: leg.carrierBondId },
    { kind: 'refund_conditional_payment', paymentId: leg.arrivalHubBondId },
  ];
  if (bonusHold) {
    effects.push({ kind: 'refund_conditional_payment', paymentId: bonusHold.paymentId });
  }
  return effects;
}

/** Cancel a HELD hub-bonus hold and give the commitment back to the sender.
 *  Used by every failure of a booked/completed final leg (ADR-014 §5). */
function refundFinalizationBonus(
  ctx: ShipmentContext,
  bonusHold: FinalizationBonusHold,
  hubStayId: string,
): ShipmentEffect[] {
  return [
    { kind: 'refund_conditional_payment', paymentId: bonusHold.paymentId },
    refundedEntry(
      'finalization_bonus_refunded',
      stayRef(hubStayId),
      ctx.senderId,
      ctx.shipmentId,
      bonusHold.amountMsat,
    ),
  ];
}

// ---------------------------------------------------------------------------
// The transition function

export function transition(
  state: ShipmentState | null,
  event: ShipmentEvent,
  ctx: ShipmentContext,
): TransitionResult {
  if (state !== null && isTerminalState(state)) {
    return illegal(state, event.type, `state ${state} is terminal: no event is legal`);
  }

  switch (event.type) {
    // ------------------------------------------------------------------ #1
    case 'create': {
      if (state !== null) return illegal(state, event.type, 'shipment already exists');
      if (!ctx.senderWalletConnected) {
        return guardFailed(state, event.type, 'sender wallet must be connected (NWC) to create');
      }
      if (ctx.originHubId === ctx.destHubId) {
        return guardFailed(state, event.type, 'origin and destination hubs must differ');
      }
      if (ctx.offerMsat <= 0n || ctx.custodyBondMsat <= 0n) {
        return guardFailed(state, event.type, 'offer and custody bond must both be > 0 msat');
      }
      if (ctx.workCommitmentMsat !== splitCommitment(ctx.offerMsat).workMsat) {
        // At create the segment IS the offer: its work pool is fixed by the
        // ADR-014 split, not chosen by the caller (after a reroute the API
        // passes the frozen pool instead, which this guard cannot see).
        return guardFailed(state, event.type, 'work commitment must be the ADR-014 work part of the offer');
      }
      return ok('DRAFT', [
        {
          kind: 'append_custody_event',
          type: 'created',
          actorUserId: ctx.senderId,
          legId: null,
          hubStayId: null,
          payload: {
            originHubId: ctx.originHubId,
            destHubId: ctx.destHubId,
            offerMsat: ctx.offerMsat,
            custodyBondMsat: ctx.custodyBondMsat,
          },
        },
      ]);
    }

    // ------------------------------------------------------------------ #2
    case 'origin_hub_accept': {
      if (state !== 'DRAFT') return illegal(state, event.type, 'origin_hub_accept is legal only in DRAFT');
      if (!event.hubWalletConnected) {
        return guardFailed(state, event.type, 'origin hub wallet must be connected to bind its bond');
      }
      const ref = stayRef(event.hubStayId);
      return ok('AWAITING_DROPOFF', [
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: ctx.originHubUserId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref,
        },
        heldEntry('hub_bond_held', ref, ctx.originHubUserId, ctx.shipmentId, ctx.custodyBondMsat),
        {
          kind: 'append_custody_event',
          type: 'funded',
          actorUserId: ctx.originHubUserId,
          legId: null,
          hubStayId: event.hubStayId,
          payload: { custodyBondMsat: ctx.custodyBondMsat },
        },
      ]);
    }

    // ------------------------------------------------------------------ #3
    case 'origin_checkin': {
      if (state !== 'AWAITING_DROPOFF') {
        return illegal(state, event.type, 'origin_checkin is legal only in AWAITING_DROPOFF');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no reserved hub stay in context');
      if (event.photoSha256.length === 0) {
        return guardFailed(state, event.type, 'check-in photo is mandatory (table row 3)');
      }
      return ok('AT_HUB', [
        { kind: 'schedule_timeout', timeout: 'storage', refId: stay.hubStayId, at: event.storageDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'hub_checkin',
          actorUserId: stay.hubUserId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: { photoSha256: event.photoSha256 },
        },
      ]);
    }

    // ------------------------------------------------------------------ #4
    case 'leg_accept': {
      if (state !== 'AT_HUB') return illegal(state, event.type, 'leg_accept is legal only in AT_HUB');
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (ctx.leg !== null) {
        return guardFailed(state, event.type, 'another leg is already pending or active');
      }
      if (!event.carrierTripActive) {
        return guardFailed(state, event.type, 'carrier must have an active declared trip (MATCHING.md)');
      }
      if (!event.carrierWalletConnected) {
        return guardFailed(state, event.type, 'carrier wallet must be connected to bind its bond');
      }
      if (!event.arrivalHubAutoAccepts || !event.arrivalHubWalletConnected) {
        return guardFailed(
          state,
          event.type,
          'arrival hub must auto-accept deposits and have a connected wallet (no human in the loop)',
        );
      }
      if (event.toHubId === stay.hubId) {
        return guardFailed(state, event.type, 'arrival hub must differ from the current hub');
      }
      if (!pricingIsConsistent(event.pricing)) {
        return guardFailed(state, event.type, 'leg pricing must satisfy gross = dep + arr + net, gross > 0');
      }
      if (event.finalizationHubBonusMsat < 0n) {
        return guardFailed(state, event.type, 'finalization hub bonus must be >= 0 msat');
      }
      const isFinalLeg = event.toHubId === ctx.destHubId;
      if (!isFinalLeg && (event.pricing.finalizationBonusMsat > 0n || event.finalizationHubBonusMsat > 0n)) {
        // Only the leg that delivers to the destination may carry the bonus
        // (ADR-014): a non-final leg smuggling either share is a pricing bug.
        return guardFailed(state, event.type, 'only the final leg may carry finalization-bonus shares');
      }
      if (ctx.finalizationBonusHold !== null) {
        // Set only while a final leg is pending/active or awaiting pickup —
        // states where leg_accept is barred anyway. A hold surviving here
        // means the API failed to clear a cancelled one: refuse to stack.
        return guardFailed(state, event.type, 'a finalization-bonus hold is already pending');
      }
      const ref: PaymentRef = { type: 'leg', id: event.legId };
      const effects: ShipmentEffect[] = [
        // The three holds of ESCROW.md §3 — the carrier never works on credit.
        // On a final leg the payment hold also binds the carrier bonus share
        // Π_v: one hold, one preimage, one collection (ADR-014).
        {
          kind: 'create_conditional_payment',
          purpose: 'leg_payment',
          payerId: ctx.senderId,
          payeeId: event.carrierId,
          amountMsat: event.pricing.grossMsat + event.pricing.finalizationBonusMsat,
          ref,
        },
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: event.carrierId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref,
        },
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: event.toHubUserId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref: stayRef(event.arrivalHubStayId),
        },
      ];
      if (event.finalizationHubBonusMsat > 0n) {
        // Fourth hold of ADR-014: the hub share Π_h, sender → destination hub,
        // in the same funding window; released only at recipient_pickup. A
        // zero share creates no hold (mirroring zero-amount fees).
        effects.push({
          kind: 'create_conditional_payment',
          purpose: 'finalization_bonus',
          payerId: ctx.senderId,
          payeeId: event.toHubUserId,
          amountMsat: event.finalizationHubBonusMsat,
          ref: stayRef(event.arrivalHubStayId),
        });
      }
      effects.push(
        { kind: 'schedule_timeout', timeout: 'leg_funding', refId: event.legId, at: event.fundingDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'leg_accepted',
          actorUserId: event.carrierId,
          legId: event.legId,
          hubStayId: null,
          payload: {
            toHubId: event.toHubId,
            grossMsat: event.pricing.grossMsat,
            depHubFeeMsat: event.pricing.depHubFeeMsat,
            arrHubFeeMsat: event.pricing.arrHubFeeMsat,
            netMsat: event.pricing.netMsat,
            finalizationBonusMsat: event.pricing.finalizationBonusMsat,
            finalizationHubBonusMsat: event.finalizationHubBonusMsat,
            custodyBondMsat: ctx.custodyBondMsat,
          },
        },
      );
      return ok('AT_HUB', effects);
    }

    // ------------------------------------------------------------------ #5
    case 'leg_funded': {
      if (state !== 'AT_HUB') return illegal(state, event.type, 'leg_funded is legal only in AT_HUB');
      const stay = ctx.currentHubStay;
      const leg = ctx.leg;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (!leg) return guardFailed(state, event.type, 'no pending leg to fund');
      if (!withinDeadline(event.now, leg.fundingDeadlineAt)) {
        return guardFailed(state, event.type, 'funding window expired (60 min, table row 5)');
      }
      const bonusHold = ctx.finalizationBonusHold;
      const effects: ShipmentEffect[] = [
        // Every hold is now held — all three of ESCROW.md §3 plus, on a final
        // leg, the hub-bonus hold: recognize the commitments (ADR-010). The
        // leg payment binds gross + carrier bonus share (ADR-014).
        heldEntry('leg_payment_held', legRef(leg), ctx.senderId, ctx.shipmentId, legHoldAmount(leg)),
        heldEntry('carrier_bond_held', legRef(leg), leg.carrierId, ctx.shipmentId, ctx.custodyBondMsat),
        heldEntry(
          'hub_bond_held',
          stayRef(leg.arrivalHubStayId),
          leg.toHubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
      ];
      if (bonusHold) {
        effects.push(
          heldEntry(
            'finalization_bonus_held',
            stayRef(leg.arrivalHubStayId),
            ctx.senderId,
            ctx.shipmentId,
            bonusHold.amountMsat,
          ),
        );
      }
      effects.push(
        { kind: 'cancel_timeout', timeout: 'leg_funding', refId: leg.legId },
        // Storage pauses while a carrier is committed; it resumes with the
        // original deadline if pickup_timeout puts the parcel back.
        { kind: 'cancel_timeout', timeout: 'storage', refId: stay.hubStayId },
        { kind: 'schedule_timeout', timeout: 'pickup', refId: leg.legId, at: event.pickupDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'funded',
          actorUserId: null, // wallet-observed event, no human actor
          legId: leg.legId,
          hubStayId: null,
          payload: {
            grossMsat: leg.pricing.grossMsat,
            finalizationBonusMsat: leg.pricing.finalizationBonusMsat,
            finalizationHubBonusMsat: bonusHold?.amountMsat ?? 0n,
            custodyBondMsat: ctx.custodyBondMsat,
          },
        },
      );
      return ok('LEG_BOOKED', effects);
    }

    // ------------------------------------------------------- #5 (expiry arm)
    case 'leg_funding_expired': {
      if (state !== 'AT_HUB') {
        return illegal(state, event.type, 'leg_funding_expired is legal only in AT_HUB');
      }
      const leg = ctx.leg;
      if (!leg) return guardFailed(state, event.type, 'no pending leg to expire');
      if (!deadlinePassed(event.now, leg.fundingDeadlineAt)) {
        return guardFailed(state, event.type, 'funding window has not expired yet');
      }
      return ok('AT_HUB', [
        ...refundPendingLegHolds(leg, ctx.finalizationBonusHold),
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: leg.legId,
          hubStayId: null,
          payload: { reason: 'leg_funding' },
        },
      ]);
    }

    // ------------------------------------------------------------------ #6
    case 'pickup_checkout': {
      if (state !== 'LEG_BOOKED') {
        return illegal(state, event.type, 'pickup_checkout is legal only in LEG_BOOKED');
      }
      const stay = ctx.currentHubStay;
      const leg = ctx.leg;
      if (!stay || !leg || !leg.pickupDeadlineAt) {
        return guardFailed(state, event.type, 'booked leg with pickup deadline required in context');
      }
      if (!event.hubConfirmed || !event.carrierConfirmed) {
        return guardFailed(state, event.type, 'both parties must confirm the handoff (double conferma)');
      }
      if (event.photoSha256.length === 0) {
        return guardFailed(state, event.type, 'check-out photo is mandatory (ARCHITECTURE.md §7)');
      }
      if (!withinDeadline(event.now, leg.pickupDeadlineAt)) {
        return guardFailed(state, event.type, 'pickup deadline has passed');
      }
      return ok('IN_TRANSIT', [
        // Departure fee paid on the spot; certification unlocks on payment.
        ...instantPayment(
          'dep_hub_fee',
          'dep_hub_fee_paid',
          legRef(leg),
          leg.carrierId,
          stay.hubUserId,
          leg.pricing.depHubFeeMsat,
        ),
        // The ceding hub's custody ends: its bond is released back.
        { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(stay.hubStayId),
          stay.hubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        { kind: 'cancel_timeout', timeout: 'pickup', refId: leg.legId },
        { kind: 'schedule_timeout', timeout: 'transit', refId: leg.legId, at: event.transitDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'hub_checkout',
          // The carrier takes custody and certifies what they accepted.
          actorUserId: leg.carrierId,
          legId: leg.legId,
          hubStayId: stay.hubStayId,
          payload: { photoSha256: event.photoSha256, hubConfirmed: true, carrierConfirmed: true },
        },
      ]);
    }

    // ------------------------------------------------------------------ #7
    case 'pickup_timeout': {
      if (state !== 'LEG_BOOKED') {
        return illegal(state, event.type, 'pickup_timeout is legal only in LEG_BOOKED');
      }
      const stay = ctx.currentHubStay;
      const leg = ctx.leg;
      if (!stay || !leg || !leg.pickupDeadlineAt) {
        return guardFailed(state, event.type, 'booked leg with pickup deadline required in context');
      }
      if (!deadlinePassed(event.now, leg.pickupDeadlineAt)) {
        return guardFailed(state, event.type, 'pickup deadline has not passed yet');
      }
      return ok('AT_HUB', [
        // Slash: the sender collects the carrier bond directly (ADR-012).
        { kind: 'release_conditional_payment', paymentId: leg.carrierBondId },
        settledEntry('carrier_bond_slashed', legRef(leg), ctx.senderId, ctx.shipmentId, ctx.custodyBondMsat),
        { kind: 'refund_conditional_payment', paymentId: leg.legPaymentId },
        refundedEntry('leg_payment_refunded', legRef(leg), ctx.senderId, ctx.shipmentId, legHoldAmount(leg)),
        { kind: 'refund_conditional_payment', paymentId: leg.arrivalHubBondId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(leg.arrivalHubStayId),
          leg.toHubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        // A failed final leg gives the bonus back too: it stays available for
        // the next final leg (ADR-014 §5).
        ...(ctx.finalizationBonusHold
          ? refundFinalizationBonus(ctx, ctx.finalizationBonusHold, leg.arrivalHubStayId)
          : []),
        // Back on the board: storage resumes with its original deadline.
        { kind: 'schedule_timeout', timeout: 'storage', refId: stay.hubStayId, at: stay.storageDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: leg.legId,
          hubStayId: null,
          payload: { reason: 'pickup_timeout' },
        },
      ]);
    }

    // -------------------------------------------------------------- #8 / #9
    case 'leg_checkin': {
      if (state !== 'IN_TRANSIT') {
        return illegal(state, event.type, 'leg_checkin is legal only in IN_TRANSIT');
      }
      const leg = ctx.leg;
      if (!leg || !leg.transitDeadlineAt) {
        return guardFailed(state, event.type, 'picked-up leg with transit deadline required in context');
      }
      if (event.hubId !== leg.toHubId) {
        return guardFailed(state, event.type, 'check-in hub must be the leg arrival hub');
      }
      if (!event.integrityConfirmed) {
        return guardFailed(state, event.type, 'receiving hub must certify integrity (accept, never judge)');
      }
      if (event.photoSha256.length === 0) {
        return guardFailed(state, event.type, 'check-in photo is mandatory (table rows 8–9)');
      }
      if (!withinDeadline(event.now, leg.transitDeadlineAt)) {
        return guardFailed(state, event.type, 'transit deadline has passed');
      }
      const isDestination = event.hubId === ctx.destHubId;
      const effects: ShipmentEffect[] = [
        // Arrival fee on the spot (computed on the gross alone — the bonus
        // pays no fees, ADR-014), then the coordinator reveals the preimage:
        // the carrier collects the whole hold directly from the sender —
        // gross plus, on the final leg, the carrier bonus share.
        ...instantPayment(
          'arr_hub_fee',
          'arr_hub_fee_paid',
          legRef(leg),
          leg.carrierId,
          leg.toHubUserId,
          leg.pricing.arrHubFeeMsat,
        ),
        { kind: 'release_conditional_payment', paymentId: leg.legPaymentId },
        settledEntry('leg_payment_released', legRef(leg), leg.carrierId, ctx.shipmentId, legHoldAmount(leg)),
        { kind: 'refund_conditional_payment', paymentId: leg.carrierBondId },
        refundedEntry('carrier_bond_refunded', legRef(leg), leg.carrierId, ctx.shipmentId, ctx.custodyBondMsat),
        { kind: 'cancel_timeout', timeout: 'transit', refId: leg.legId },
        {
          kind: 'schedule_timeout',
          timeout: 'storage',
          refId: leg.arrivalHubStayId,
          at: event.storageDeadlineAt,
        },
        {
          kind: 'append_custody_event',
          type: isDestination ? 'arrived_destination' : 'hub_checkin_intermediate',
          actorUserId: leg.toHubUserId,
          legId: leg.legId,
          hubStayId: leg.arrivalHubStayId,
          payload: { photoSha256: event.photoSha256, integrityConfirmed: true },
        },
      ];
      if (isDestination) {
        // Flow step 7: the recipient is invited to pick up (OTP in the mail).
        effects.push({ kind: 'queue_email', to: 'recipient', template: 'parcel_arrived', payload: { hubId: event.hubId } });
        return ok('AWAITING_PICKUP', effects);
      }
      // Flow step 6: both sender and recipient learn where the parcel is.
      effects.push(
        { kind: 'queue_email', to: 'sender', template: 'parcel_at_intermediate_hub', payload: { hubId: event.hubId } },
        { kind: 'queue_email', to: 'recipient', template: 'parcel_at_intermediate_hub', payload: { hubId: event.hubId } },
      );
      return ok('AT_HUB', effects);
    }

    // ----------------------------------------------------------------- #10
    case 'leg_return': {
      if (state !== 'IN_TRANSIT') {
        return illegal(state, event.type, 'leg_return is legal only in IN_TRANSIT');
      }
      const leg = ctx.leg;
      if (!leg || !leg.transitDeadlineAt) {
        return guardFailed(state, event.type, 'picked-up leg with transit deadline required in context');
      }
      if (event.hubId !== leg.fromHubId) {
        return guardFailed(state, event.type, 'a leg can only be returned to its departure hub (ToS)');
      }
      if (event.photoSha256.length === 0) {
        return guardFailed(state, event.type, 'return check-in photo is mandatory');
      }
      if (!withinDeadline(event.now, leg.transitDeadlineAt)) {
        return guardFailed(state, event.type, 'transit deadline has passed (table row 10)');
      }
      const returnStayRef = stayRef(event.returnHubStayId);
      return ok('AT_HUB', [
        // Nobody collects: payment and carrier bond dissolve (ADR-012).
        { kind: 'refund_conditional_payment', paymentId: leg.legPaymentId },
        refundedEntry('leg_payment_refunded', legRef(leg), ctx.senderId, ctx.shipmentId, legHoldAmount(leg)),
        { kind: 'refund_conditional_payment', paymentId: leg.carrierBondId },
        refundedEntry('carrier_bond_refunded', legRef(leg), leg.carrierId, ctx.shipmentId, ctx.custodyBondMsat),
        // The arrival hub's stay will never activate.
        { kind: 'refund_conditional_payment', paymentId: leg.arrivalHubBondId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(leg.arrivalHubStayId),
          leg.toHubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        // A returned final leg gives the bonus back too (ADR-014 §5).
        ...(ctx.finalizationBonusHold
          ? refundFinalizationBonus(ctx, ctx.finalizationBonusHold, leg.arrivalHubStayId)
          : []),
        // The re-accepting hub takes custody again, so it posts a fresh bond
        // (§6: the bond follows the custody; its old one was refunded at
        // check-out and cannot be resurrected).
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: leg.fromHubUserId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref: returnStayRef,
        },
        heldEntry('hub_bond_held', returnStayRef, leg.fromHubUserId, ctx.shipmentId, ctx.custodyBondMsat),
        { kind: 'cancel_timeout', timeout: 'transit', refId: leg.legId },
        // "La giacenza riparte" (table row 10): a fresh storage window.
        {
          kind: 'schedule_timeout',
          timeout: 'storage',
          refId: event.returnHubStayId,
          at: event.storageDeadlineAt,
        },
        {
          kind: 'append_custody_event',
          type: 'leg_returned',
          actorUserId: leg.fromHubUserId,
          legId: leg.legId,
          hubStayId: event.returnHubStayId,
          payload: { photoSha256: event.photoSha256 },
        },
      ]);
    }

    // ----------------------------------------------------------------- #11
    case 'recipient_pickup': {
      if (state !== 'AWAITING_PICKUP') {
        return illegal(state, event.type, 'recipient_pickup is legal only in AWAITING_PICKUP');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active destination hub stay in context');
      if (!event.otpVerified) {
        return guardFailed(state, event.type, 'OTP must be verified: typing it is the final acceptance');
      }
      const bonusHold = ctx.finalizationBonusHold;
      const effects: ShipmentEffect[] = [];
      if (bonusHold) {
        // The hub is rewarded for COMPLETING the delivery, not for receiving
        // the parcel: the Π_h preimage is revealed only now (ADR-014 §3).
        effects.push(
          { kind: 'release_conditional_payment', paymentId: bonusHold.paymentId },
          settledEntry(
            'finalization_bonus_released',
            stayRef(stay.hubStayId),
            stay.hubUserId,
            ctx.shipmentId,
            bonusHold.amountMsat,
          ),
        );
      }
      effects.push(
        { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(stay.hubStayId),
          stay.hubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        { kind: 'cancel_timeout', timeout: 'storage', refId: stay.hubStayId },
        {
          kind: 'append_custody_event',
          type: 'recipient_pickup',
          actorUserId: stay.hubUserId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: { otpVerified: true },
        },
        { kind: 'queue_email', to: 'sender', template: 'parcel_delivered', payload: {} },
      );
      return ok('DELIVERED', effects);
    }

    // ----------------------------------------------------------------- #12
    case 'handoff_reject': {
      // Documentary only (ADR-012): custody does NOT pass, the state does not
      // change, no money moves. The rejection is evidence plus a notification
      // to the sender, who can react with reroute/boost.
      const legalStage: Record<typeof event.stage, ShipmentState> = {
        pickup_checkout: 'LEG_BOOKED',
        hub_checkin: 'IN_TRANSIT',
        recipient_pickup: 'AWAITING_PICKUP',
      };
      if (state !== 'LEG_BOOKED' && state !== 'IN_TRANSIT' && state !== 'AWAITING_PICKUP') {
        return illegal(state, event.type, 'handoff_reject is legal only at a physical handoff');
      }
      if (legalStage[event.stage] !== state) {
        return guardFailed(state, event.type, `stage ${event.stage} does not match state ${state}`);
      }
      if (event.photoSha256.length === 0 || event.reason.trim() === '') {
        return guardFailed(state, event.type, 'a rejection requires photos and a reason (table row 12)');
      }
      return ok(state, [
        {
          kind: 'append_custody_event',
          type: 'handoff_rejected',
          actorUserId: event.rejectedById,
          legId: ctx.leg?.legId ?? null,
          hubStayId: ctx.currentHubStay?.hubStayId ?? null,
          payload: { stage: event.stage, reason: event.reason, photoSha256: event.photoSha256 },
        },
        {
          kind: 'queue_email',
          to: 'sender',
          template: 'handoff_rejected',
          payload: { stage: event.stage, reason: event.reason },
        },
      ]);
    }

    // ----------------------------------------------------------------- #13
    case 'storage_expiry': {
      if (state !== 'AT_HUB' && state !== 'AWAITING_PICKUP') {
        return illegal(state, event.type, 'storage_expiry is legal only in AT_HUB or AWAITING_PICKUP');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (!deadlinePassed(event.now, stay.storageDeadlineAt)) {
        return guardFailed(state, event.type, 'storage deadline has not passed yet');
      }
      const effects: ShipmentEffect[] = [];
      if (state === 'AT_HUB' && ctx.leg !== null) {
        // A leg still pending funding: dissolve its holds (the hub-bonus one
        // included, if this was a final leg) and disarm its window — the
        // shipment is over.
        effects.push(...refundPendingLegHolds(ctx.leg, ctx.finalizationBonusHold), {
          kind: 'cancel_timeout',
          timeout: 'leg_funding',
          refId: ctx.leg.legId,
        });
      } else if (state === 'AWAITING_PICKUP' && ctx.finalizationBonusHold) {
        // Expired at the destination: the hub is compensated by the forfeited
        // parcel, never by the bonus — the held Π_h returns to the sender
        // (ADR-014 §5).
        effects.push(...refundFinalizationBonus(ctx, ctx.finalizationBonusHold, stay.hubStayId));
      }
      effects.push(
        // The hub's bond is released; the parcel itself, forfeited under the
        // ToS, is the hub's compensation — no prefunded pot exists (ADR-013).
        { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(stay.hubStayId),
          stay.hubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: { reason: 'storage' },
        },
      );
      return ok('FORFEITED', effects);
    }

    // ----------------------------------------------------------------- #14
    case 'transit_timeout': {
      if (state !== 'IN_TRANSIT') {
        return illegal(state, event.type, 'transit_timeout is legal only in IN_TRANSIT');
      }
      const leg = ctx.leg;
      if (!leg || !leg.transitDeadlineAt) {
        return guardFailed(state, event.type, 'picked-up leg with transit deadline required in context');
      }
      if (!deadlinePassed(event.now, leg.transitDeadlineAt)) {
        return guardFailed(state, event.type, 'transit deadline has not passed yet');
      }
      return ok('LOST', [
        // Slash to the sender; fees already paid on the spot stay paid.
        { kind: 'release_conditional_payment', paymentId: leg.carrierBondId },
        settledEntry('carrier_bond_slashed', legRef(leg), ctx.senderId, ctx.shipmentId, ctx.custodyBondMsat),
        { kind: 'refund_conditional_payment', paymentId: leg.legPaymentId },
        refundedEntry('leg_payment_refunded', legRef(leg), ctx.senderId, ctx.shipmentId, legHoldAmount(leg)),
        { kind: 'refund_conditional_payment', paymentId: leg.arrivalHubBondId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(leg.arrivalHubStayId),
          leg.toHubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        // A lost final leg also dissolves the hub-bonus hold (ADR-014 §5).
        ...(ctx.finalizationBonusHold
          ? refundFinalizationBonus(ctx, ctx.finalizationBonusHold, leg.arrivalHubStayId)
          : []),
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: leg.legId,
          hubStayId: null,
          payload: { reason: 'transit_timeout' },
        },
      ]);
    }

    // ----------------------------------------------------------------- #15
    case 'boost': {
      // No money moves: the spending commitment grows for FUTURE legs
      // (ECONOMICS.md §5). Legal wherever the parcel is idle — including
      // AWAITING_PICKUP: a reroute from there with an exhausted pool
      // REQUIRES a boost first.
      if (state !== 'AT_HUB' && state !== 'AWAITING_PICKUP') {
        return illegal(state, event.type, 'boost is legal only while the parcel is idle at a hub');
      }
      if (event.amountMsat <= 0n) {
        return guardFailed(state, event.type, 'boost amount must be > 0 msat');
      }
      if (!Number.isFinite(event.atRemainingKm) || event.atRemainingKm <= 0) {
        return guardFailed(state, event.type, 'boost remaining distance must be a finite km value > 0');
      }
      return ok(state, [
        {
          kind: 'append_custody_event',
          type: 'boosted',
          actorUserId: ctx.senderId,
          legId: null,
          hubStayId: ctx.currentHubStay?.hubStayId ?? null,
          payload: { amountMsat: event.amountMsat, atRemainingKm: event.atRemainingKm },
        },
      ]);
    }

    // ----------------------------------------------------------------- #16
    case 'reroute': {
      // No money moves: the pool is re-frozen over the new remaining
      // distance (applyReroute in economics). The pickup OTP is invalidated
      // and reissued so the OLD recipient's mail can no longer collect.
      if (state !== 'AT_HUB' && state !== 'AWAITING_PICKUP') {
        return illegal(state, event.type, 'reroute is legal only in AT_HUB or AWAITING_PICKUP');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (ctx.leg !== null) {
        return guardFailed(state, event.type, 'reroute requires no pending or booked leg (table row 16)');
      }
      if (event.newDestHubId === null && event.newRecipientEmail === null) {
        return guardFailed(state, event.type, 'reroute must change the destination hub and/or the recipient');
      }
      if (event.newDestHubId !== null && event.newDestHubId === stay.hubId) {
        return guardFailed(state, event.type, 'new destination cannot be the hub the parcel already sits at');
      }
      if (!Number.isFinite(event.newRemainingKm) || event.newRemainingKm <= 0) {
        return guardFailed(state, event.type, 'new remaining distance must be a finite km value > 0');
      }
      // A recipient-only change while the parcel already sits at the
      // destination keeps AWAITING_PICKUP (moving to AT_HUB would strand it:
      // no positive-progress leg exists from the destination) and the new
      // recipient is invited right away with the fresh OTP. Any destination
      // change turns the current hub into an intermediate stop: AT_HUB.
      const staysAtDestination = state === 'AWAITING_PICKUP' && event.newDestHubId === null;
      const effects: ShipmentEffect[] = [];
      if (state === 'AWAITING_PICKUP' && event.newDestHubId !== null && ctx.finalizationBonusHold) {
        // Rerouting away from the delivery state cancels the hub-bonus hold:
        // the premium follows the parcel, and the next final leg will freeze
        // a fresh Π_h toward the NEW destination hub (ADR-014 §5). A
        // recipient-only change keeps the hold: this hub still delivers.
        effects.push(...refundFinalizationBonus(ctx, ctx.finalizationBonusHold, stay.hubStayId));
      }
      effects.push(
        {
          kind: 'append_custody_event',
          type: 'rerouted',
          actorUserId: ctx.senderId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: {
            // No PII in the immutable chain: record THAT the recipient
            // changed, never the address itself (RISKS.md §6).
            newDestHubId: event.newDestHubId,
            recipientChanged: event.newRecipientEmail !== null,
            newRemainingKm: event.newRemainingKm,
          },
        },
        { kind: 'rotate_pickup_otp' },
      );
      if (staysAtDestination) {
        effects.push({ kind: 'queue_email', to: 'recipient', template: 'parcel_arrived', payload: { hubId: stay.hubId } });
        return ok('AWAITING_PICKUP', effects);
      }
      return ok('AT_HUB', effects);
    }

    // ----------------------------------------------------------------- #17
    case 'cancel': {
      if (state === 'DRAFT') {
        return ok('CANCELLED', [
          {
            kind: 'append_custody_event',
            type: 'cancelled',
            actorUserId: ctx.senderId,
            legId: null,
            hubStayId: null,
            payload: {},
          },
        ]);
      }
      if (state === 'AWAITING_DROPOFF') {
        const stay = ctx.currentHubStay;
        if (!stay) return guardFailed(state, event.type, 'no reserved hub stay in context');
        return ok('CANCELLED', [
          { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
          refundedEntry(
            'hub_bond_refunded',
            stayRef(stay.hubStayId),
            stay.hubUserId,
            ctx.shipmentId,
            ctx.custodyBondMsat,
          ),
          {
            kind: 'append_custody_event',
            type: 'cancelled',
            actorUserId: ctx.senderId,
            legId: null,
            hubStayId: stay.hubStayId,
            payload: {},
          },
        ]);
      }
      if (state === 'AT_HUB') {
        const stay = ctx.currentHubStay;
        if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
        if (ctx.leg !== null) {
          return guardFailed(state, event.type, 'cancel requires no pending or booked leg');
        }
        if (stay.hubId !== ctx.originHubId) {
          // Only before the first pickup_checkout, i.e. while still at the
          // origin hub; farther along the sender must reroute instead.
          return guardFailed(state, event.type, 'cancel is legal only while the parcel is at the origin hub');
        }
        const compensation = cancellationCompensation(ctx.workCommitmentMsat, ctx.originHubFeeBp);
        const shipRef: LedgerRef = { type: 'shipment', id: ctx.shipmentId };
        return ok('CANCELLED', [
          // f_o × the segment's work commitment paid directly sender → hub:
          // what the hub would have earned from a single-leg journey, which
          // under ADR-014 is priced on the work pool; the parcel's return
          // unlocks on payment (ECONOMICS.md, regole di contorno).
          ...instantPayment(
            'cancellation_compensation',
            'cancellation_compensation_paid',
            shipRef,
            ctx.senderId,
            stay.hubUserId,
            compensation,
          ),
          { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
          refundedEntry(
            'hub_bond_refunded',
            stayRef(stay.hubStayId),
            stay.hubUserId,
            ctx.shipmentId,
            ctx.custodyBondMsat,
          ),
          { kind: 'cancel_timeout', timeout: 'storage', refId: stay.hubStayId },
          {
            kind: 'append_custody_event',
            type: 'cancelled',
            actorUserId: ctx.senderId,
            legId: null,
            hubStayId: stay.hubStayId,
            payload: { compensationMsat: compensation },
          },
        ]);
      }
      return illegal(state, event.type, 'cancel is legal only before the first pickup_checkout');
    }
  }
}
