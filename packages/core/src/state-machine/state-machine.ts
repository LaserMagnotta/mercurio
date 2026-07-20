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
//
// Recipient claim (ADR-016): while the parcel is idle AT_HUB the recipient
// may claim it with the bearer token from the tracking mail, collecting the
// remaining work pool plus the unconsumed Π_v (they finish the carriage
// themselves); the pickup hub collects the accrued Π_h. The cycle mirrors a
// leg's funding: recipient_claim opens the hold(s) and arms a funding window
// (the shipment leaves the board and leg_accept is barred), claim_funded
// books the pickup (CLAIMED), claim_funding_expired dissolves it back onto
// the board, recipient_claimed_pickup settles everything and closes the
// shipment. Storage does NOT pause during a claim: storage_expiry while a
// claim is pending or CLAIMED forfeits the parcel and dissolves the claim
// holds, mirroring the pending-leg rule. Boost, reroute and cancel are
// rejected while a claim is in flight.
//
// Deposit request (ADR-029): the old leg_accept is split in two. leg_request
// (carrier) freezes the price and arms a 30-minute response window but moves
// NO money; deposit_accept (arrival hub — auto-fired by the API for
// auto_accept hubs) is exactly the old leg_accept's effect: it creates the
// 3–4 holds and arms the funding window. deposit_reject /
// deposit_request_expired / deposit_request_cancel dissolve the request at
// zero cost — no hold ever existed — and the shipment returns to the board.
// A pending request is board-exclusive like a claim: leg_request,
// recipient_claim, boost, reroute and cancel are all rejected while one is
// in flight.

import type {
  ActiveHubStay,
  ActiveLeg,
  FinalizationBonusHold,
  LedgerPosting,
  LedgerRef,
  Msat,
  PaymentRef,
  PendingClaim,
  ShipmentContext,
  ShipmentEffect,
  ShipmentEvent,
  ShipmentEventType,
  ShipmentState,
  TransitionResult,
} from '@mercurio/shared';
import { BOND_RENEWAL_LEAD_HOURS } from '@mercurio/shared';
import { cancellationCompensation, splitCommitment } from '../economics/economics.js';

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

/** Pure clock arithmetic for derived instants (the bond_renewal timer fires
 *  BOND_RENEWAL_LEAD_HOURS before its window closes — ADR-033). */
function isoMinusHours(iso: string, hours: number): string {
  return new Date(epoch(iso) - hours * 60 * 60 * 1000).toISOString();
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

function claimRef(claim: PendingClaim): PaymentRef {
  return { type: 'claim', id: claim.claimId };
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

/** Cancel the claim hold(s) of a claim that never got funded (ADR-016). No
 *  journal entries: commitments enter the shadow ledger only at claim_funded
 *  — same rule as a leg's funding window. */
function refundPendingClaimHolds(claim: PendingClaim): ShipmentEffect[] {
  const effects: ShipmentEffect[] = [
    { kind: 'refund_conditional_payment', paymentId: claim.claimPaymentId },
  ];
  if (claim.hubBonusPaymentId) {
    effects.push({ kind: 'refund_conditional_payment', paymentId: claim.hubBonusPaymentId });
  }
  return effects;
}

/** Cancel the HELD claim hold(s) of a booked claim (CLAIMED) and give the
 *  commitments back to the sender — storage_expiry's mirror of the
 *  pending-leg rule (ADR-016). */
function refundHeldClaimHolds(ctx: ShipmentContext, claim: PendingClaim): ShipmentEffect[] {
  const ref = claimRef(claim);
  const effects: ShipmentEffect[] = [
    { kind: 'refund_conditional_payment', paymentId: claim.claimPaymentId },
    refundedEntry('claim_payment_refunded', ref, ctx.senderId, ctx.shipmentId, claim.claimPaymentMsat),
  ];
  if (claim.hubBonusPaymentId) {
    effects.push(
      { kind: 'refund_conditional_payment', paymentId: claim.hubBonusPaymentId },
      refundedEntry('finalization_bonus_refunded', ref, ctx.senderId, ctx.shipmentId, claim.hubBonusMsat),
    );
  }
  return effects;
}

/** Dissolve whatever was pending on the stay when the storage ends early or
 *  on time — the branch logic shared by storage_expiry and the bond_renew
 *  failure arm (ADR-033 §3: a missed renewal IS an early storage expiry). */
function dissolvePendingOnForfeit(state: ShipmentState, ctx: ShipmentContext): ShipmentEffect[] {
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
  } else if (state === 'AT_HUB' && ctx.pendingLegRequest !== null) {
    // A deposit request still awaiting the hub's answer dies with the
    // storage (ADR-029): no hold ever existed, so the only thing to
    // dissolve is the response window.
    effects.push({
      kind: 'cancel_timeout',
      timeout: 'deposit_response',
      refId: ctx.pendingLegRequest.legId,
    });
  } else if (state === 'AT_HUB' && ctx.pendingClaim !== null) {
    // A claim still pending funding dies exactly like a pending leg
    // (ADR-016: storage never pauses for a claim): dissolve its holds —
    // never commitments yet — and disarm its window.
    effects.push(...refundPendingClaimHolds(ctx.pendingClaim), {
      kind: 'cancel_timeout',
      timeout: 'claim_funding',
      refId: ctx.pendingClaim.claimId,
    });
  } else if (state === 'CLAIMED' && ctx.pendingClaim !== null) {
    // A funded claim the claimant never collected: the held commitments
    // return to the sender; the forfeited parcel compensates the hub, as
    // in every storage expiry (ADR-013, ADR-016).
    effects.push(...refundHeldClaimHolds(ctx, ctx.pendingClaim));
  } else if (state === 'AWAITING_PICKUP' && ctx.finalizationBonusHold) {
    // Expired at the destination: the hub is compensated by the forfeited
    // parcel, never by the bonus — the held Π_h returns to the sender
    // (ADR-014 §5).
    effects.push(
      ...refundFinalizationBonus(ctx, ctx.finalizationBonusHold, ctx.currentHubStay!.hubStayId),
    );
  }
  return effects;
}

/** Release the stay's bond and document the early/on-time end of custody:
 *  the parcel itself, forfeited under the ToS, is the hub's compensation —
 *  no prefunded pot exists (ADR-013). `reason` tells 'storage' (the sender's
 *  window elapsed) from 'bond_renewal' (the hub stopped guaranteeing it). */
function forfeitBondEffects(
  ctx: ShipmentContext,
  stay: ActiveHubStay,
  reason: 'storage' | 'bond_renewal',
): ShipmentEffect[] {
  return [
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
      payload: { reason },
    },
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
            // Sender's optional creation photos (ADR-022): the genesis event
            // is the shipment's certification record, so the declared hashes
            // land here — keys present only when non-empty, keeping photo-less
            // payloads byte-identical to the pre-ADR-022 shape.
            ...(event.contentPhotoSha256 && event.contentPhotoSha256.length > 0
              ? { contentPhotoSha256: event.contentPhotoSha256 }
              : {}),
            ...(event.sealedPhotoSha256 && event.sealedPhotoSha256.length > 0
              ? { sealedPhotoSha256: event.sealedPhotoSha256 }
              : {}),
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
        // AWAITING_DROPOFF has no deadline of its own and can outlive the
        // bond's 7-day window: arm the renewal reminder now (ADR-033 §4).
        {
          kind: 'schedule_timeout',
          timeout: 'bond_renewal',
          refId: event.hubStayId,
          at: isoMinusHours(event.bondWindowEndsAt, BOND_RENEWAL_LEAD_HOURS),
        },
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
        // The journey has begun: the recipient gets the tracking mail with
        // their personal claim token (ADR-016) — the bearer credential that
        // lets them claim the parcel early at whichever hub it rests at.
        { kind: 'rotate_claim_token' },
        { kind: 'queue_email', to: 'recipient', template: 'parcel_tracking', payload: { hubId: stay.hubId } },
      ]);
    }

    // ---------------------------------------------------- #4a (ADR-029)
    case 'leg_request': {
      // The carrier asks the arrival hub to host the parcel. Guards are the
      // old leg_accept's, MINUS "the hub must auto-accept": a manual hub is a
      // legitimate destination now — it just answers first. NO money moves
      // here (the ADR-029 invariant): the price is frozen into the request so
      // the carrier knows what they would collect, the holds wait for
      // deposit_accept, and a request that dies liquidates zero msat.
      if (state !== 'AT_HUB') return illegal(state, event.type, 'leg_request is legal only in AT_HUB');
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (ctx.leg !== null) {
        return guardFailed(state, event.type, 'another leg is already pending or active');
      }
      if (ctx.pendingLegRequest !== null) {
        // Board-exclusive (decisione C): one request at a time, like a claim.
        return guardFailed(state, event.type, 'a deposit request is already pending on this shipment');
      }
      if (ctx.pendingClaim !== null) {
        // From the claim request on, the parcel is the claimant's to lose:
        // it left the board and no carrier can book it (ADR-016).
        return guardFailed(state, event.type, 'a recipient claim is pending on this shipment');
      }
      if (!event.carrierTripActive) {
        return guardFailed(state, event.type, 'carrier must have an active declared trip (MATCHING.md)');
      }
      if (!event.carrierWalletConnected) {
        return guardFailed(state, event.type, 'carrier wallet must be connected to bind its bond');
      }
      if (!event.arrivalHubWalletConnected) {
        // The hub must be ABLE to bond if it accepts (ADR-029: the only
        // arrival-hub requirement left at the request).
        return guardFailed(state, event.type, 'arrival hub wallet must be connected to bind its bond');
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
        // states where leg_request is barred anyway. A hold surviving here
        // means the API failed to clear a cancelled one: refuse to stack.
        return guardFailed(state, event.type, 'a finalization-bonus hold is already pending');
      }
      return ok('AT_HUB', [
        {
          kind: 'schedule_timeout',
          timeout: 'deposit_response',
          refId: event.legId,
          at: event.responseDeadlineAt,
        },
        {
          kind: 'append_custody_event',
          type: 'deposit_requested',
          actorUserId: event.carrierId,
          legId: event.legId,
          hubStayId: null,
          // The frozen price is documented HERE (deposit_accept freezes
          // nothing new); the context builder reads finalizationHubBonusMsat
          // back from this payload — the chain is its only store, mirroring
          // the quota accumulators (ADR-014 precisazione 8).
          payload: {
            toHubId: event.toHubId,
            grossMsat: event.pricing.grossMsat,
            depHubFeeMsat: event.pricing.depHubFeeMsat,
            arrHubFeeMsat: event.pricing.arrHubFeeMsat,
            netMsat: event.pricing.netMsat,
            finalizationBonusMsat: event.pricing.finalizationBonusMsat,
            finalizationHubBonusMsat: event.finalizationHubBonusMsat,
            custodyBondMsat: ctx.custodyBondMsat,
            responseDeadlineAt: event.responseDeadlineAt,
          },
        },
      ]);
    }

    // ---------------------------------------------------- #4b (ADR-029)
    case 'deposit_accept': {
      // The arrival hub says yes: EXACTLY the old leg_accept's money effect —
      // the 3–4 holds of ESCROW.md §3 / ADR-014 are created and the funding
      // window is armed. Every amount comes frozen from the request; the only
      // new facts are the stay id and the funding deadline.
      if (state !== 'AT_HUB') return illegal(state, event.type, 'deposit_accept is legal only in AT_HUB');
      const stay = ctx.currentHubStay;
      const req = ctx.pendingLegRequest;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (!req) return guardFailed(state, event.type, 'no pending deposit request to accept');
      if (ctx.leg !== null) {
        // Impossible by leg_request's guards; refuse an incoherent context.
        return guardFailed(state, event.type, 'another leg is already pending or active');
      }
      if (!withinDeadline(event.now, req.responseDeadlineAt)) {
        return guardFailed(state, event.type, 'deposit response window expired (ADR-029, 30 min)');
      }
      if (!event.arrivalHubWalletConnected) {
        return guardFailed(state, event.type, 'arrival hub wallet must be connected to bind its bond');
      }
      if (!pricingIsConsistent(req.pricing)) {
        return guardFailed(state, event.type, 'frozen request pricing is inconsistent');
      }
      if (ctx.finalizationBonusHold !== null) {
        return guardFailed(state, event.type, 'a finalization-bonus hold is already pending');
      }
      const ref: PaymentRef = { type: 'leg', id: req.legId };
      const effects: ShipmentEffect[] = [
        // The three holds of ESCROW.md §3 — the carrier never works on credit.
        // On a final leg the payment hold also binds the carrier bonus share
        // Π_v: one hold, one preimage, one collection (ADR-014).
        {
          kind: 'create_conditional_payment',
          purpose: 'leg_payment',
          payerId: ctx.senderId,
          payeeId: req.carrierId,
          amountMsat: req.pricing.grossMsat + req.pricing.finalizationBonusMsat,
          ref,
        },
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: req.carrierId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref,
        },
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: req.toHubUserId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref: stayRef(event.arrivalHubStayId),
        },
      ];
      if (req.finalizationHubBonusMsat > 0n) {
        // Fourth hold of ADR-014: the hub share Π_h, sender → destination hub,
        // in the same funding window; released only at recipient_pickup. A
        // zero share creates no hold (mirroring zero-amount fees).
        effects.push({
          kind: 'create_conditional_payment',
          purpose: 'finalization_bonus',
          payerId: ctx.senderId,
          payeeId: req.toHubUserId,
          amountMsat: req.finalizationHubBonusMsat,
          ref: stayRef(event.arrivalHubStayId),
        });
      }
      effects.push(
        // The answer consumes the response window and opens the funding one.
        { kind: 'cancel_timeout', timeout: 'deposit_response', refId: req.legId },
        { kind: 'schedule_timeout', timeout: 'leg_funding', refId: req.legId, at: event.fundingDeadlineAt },
        {
          kind: 'append_custody_event',
          type: 'leg_accepted', // reused (ADR-029): same protocol fact as before
          actorUserId: req.toHubUserId, // the hub is the party accepting now
          legId: req.legId,
          hubStayId: null,
          payload: {
            toHubId: req.toHubId,
            grossMsat: req.pricing.grossMsat,
            depHubFeeMsat: req.pricing.depHubFeeMsat,
            arrHubFeeMsat: req.pricing.arrHubFeeMsat,
            netMsat: req.pricing.netMsat,
            finalizationBonusMsat: req.pricing.finalizationBonusMsat,
            finalizationHubBonusMsat: req.finalizationHubBonusMsat,
            custodyBondMsat: ctx.custodyBondMsat,
          },
        },
      );
      return ok('AT_HUB', effects);
    }

    // ---------------------------------------------------- #4c (ADR-029)
    case 'deposit_reject': {
      // The hub says no. Documentation, not a judgment (ADR-012): the API
      // writes the rejections row (stage deposit_request); the chain records
      // the refusal with the SAME event type as every other refusal. No hold
      // ever existed: dissolving the request moves zero msat, the shipment is
      // back on the board the moment the requested leg row is closed.
      if (state !== 'AT_HUB') return illegal(state, event.type, 'deposit_reject is legal only in AT_HUB');
      const req = ctx.pendingLegRequest;
      if (!req) return guardFailed(state, event.type, 'no pending deposit request to reject');
      if (event.reason.trim() === '') {
        return guardFailed(state, event.type, 'a rejection requires a reason (documentation, ADR-012)');
      }
      return ok('AT_HUB', [
        { kind: 'cancel_timeout', timeout: 'deposit_response', refId: req.legId },
        {
          kind: 'append_custody_event',
          type: 'handoff_rejected',
          actorUserId: event.rejectedById,
          legId: req.legId,
          hubStayId: null,
          payload: { stage: 'deposit_request', reason: event.reason },
        },
        // ADR-029: "il vettore è avvisato e sceglie un altro hub".
        {
          kind: 'queue_email',
          to: 'carrier',
          template: 'deposit_request_rejected',
          payload: { hubId: req.toHubId, outcome: 'rejected', reason: event.reason },
        },
      ]);
    }

    // ---------------------------------------------------- #4d (ADR-029)
    case 'deposit_request_expired': {
      // The response window elapsed with no answer (worker). Consumes its own
      // timer (the sweep fired it); zero money by construction.
      if (state !== 'AT_HUB') {
        return illegal(state, event.type, 'deposit_request_expired is legal only in AT_HUB');
      }
      const req = ctx.pendingLegRequest;
      if (!req) return guardFailed(state, event.type, 'no pending deposit request to expire');
      if (!deadlinePassed(event.now, req.responseDeadlineAt)) {
        return guardFailed(state, event.type, 'deposit response window has not expired yet');
      }
      return ok('AT_HUB', [
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: req.legId,
          hubStayId: null,
          payload: { reason: 'deposit_response' },
        },
        {
          kind: 'queue_email',
          to: 'carrier',
          template: 'deposit_request_rejected',
          payload: { hubId: req.toHubId, outcome: 'expired' },
        },
      ]);
    }

    // ---------------------------------------------------- #4e (ADR-029)
    case 'deposit_request_cancel': {
      // The carrier withdraws to re-target quickly. Zero money, no email
      // (they did it themselves), no rejections row (nobody refused).
      if (state !== 'AT_HUB') {
        return illegal(state, event.type, 'deposit_request_cancel is legal only in AT_HUB');
      }
      const req = ctx.pendingLegRequest;
      if (!req) return guardFailed(state, event.type, 'no pending deposit request to cancel');
      return ok('AT_HUB', [
        { kind: 'cancel_timeout', timeout: 'deposit_response', refId: req.legId },
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: req.carrierId,
          legId: req.legId,
          hubStayId: null,
          payload: { reason: 'deposit_request_cancelled' },
        },
      ]);
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
        // The ceding stay's renewal reminder dies with its bond (ADR-033 §4).
        { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
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
        // The arrival bond's renewal reminder starts with the stay (ADR-033
        // §4): its window was frozen at deposit_accept, when the hold was
        // created. Absent only on legacy stays, which never renew.
        ...(leg.arrivalBondWindowEndsAt
          ? [
              {
                kind: 'schedule_timeout',
                timeout: 'bond_renewal',
                refId: leg.arrivalHubStayId,
                at: isoMinusHours(leg.arrivalBondWindowEndsAt, BOND_RENEWAL_LEAD_HOURS),
              } satisfies ShipmentEffect,
            ]
          : []),
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
        // Fresh bond, fresh renewal window (ADR-033 §4).
        {
          kind: 'schedule_timeout',
          timeout: 'bond_renewal',
          refId: event.returnHubStayId,
          at: isoMinusHours(event.bondWindowEndsAt, BOND_RENEWAL_LEAD_HOURS),
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
        { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
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

    // ----------------------------------------------------------------- #18
    case 'recipient_claim': {
      // ADR-016: legal ONLY while the parcel idles AT_HUB. Not from
      // AWAITING_PICKUP — there the OTP pickup already exists and nothing is
      // left to claim (pool 0, Π_v consumed).
      if (state !== 'AT_HUB') {
        return illegal(state, event.type, 'recipient_claim is legal only while the parcel idles AT_HUB');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (ctx.leg !== null) {
        return guardFailed(state, event.type, 'a leg is pending or booked: nothing can be claimed');
      }
      if (ctx.pendingLegRequest !== null) {
        // A pending deposit request is board-exclusive (ADR-029, decisione C):
        // the parcel is the requesting carrier's to lose until the hub answers.
        return guardFailed(state, event.type, 'a deposit request is pending on this shipment');
      }
      if (ctx.pendingClaim !== null) {
        return guardFailed(state, event.type, 'a claim is already pending on this shipment');
      }
      if (ctx.finalizationBonusHold !== null) {
        // Same defense as leg_accept: a leg's Π_h hold surviving here means
        // the API failed to clear a cancelled one — refuse to stack a second
        // hub-bonus hold on top of it.
        return guardFailed(state, event.type, 'a finalization-bonus hold is already pending');
      }
      if (!event.claimTokenVerified) {
        return guardFailed(state, event.type, 'the claim token must be verified (bearer credential)');
      }
      if (!event.claimantWalletConnected) {
        return guardFailed(state, event.type, 'claimant wallet must be connected: the claim collects money');
      }
      // Disjoint roles (ADR-013: on Lightning payer ≠ payee): the sender pays
      // the claimant, and the pickup handoff must not be a self-dealing.
      if (event.claimantId === ctx.senderId) {
        return guardFailed(state, event.type, 'claimant must differ from the sender');
      }
      if (event.claimantId === stay.hubUserId) {
        return guardFailed(state, event.type, 'claimant must differ from the pickup hub owner');
      }
      if (event.claimPaymentMsat <= 0n) {
        // Zero-amount holds do not exist on Lightning: with the pool exhausted
        // and Π_v consumed there is nothing to collect — the sender must boost
        // first, exactly as for any carrier (ADR-016).
        return guardFailed(state, event.type, 'claim payment must be > 0 msat (nothing left to claim)');
      }
      if (event.hubBonusMsat < 0n) {
        return guardFailed(state, event.type, 'hub bonus must be >= 0 msat');
      }
      const ref: PaymentRef = { type: 'claim', id: event.claimId };
      const effects: ShipmentEffect[] = [
        // The claim payment: remaining pool + unconsumed Π_v, sender →
        // recipient (ESCROW.md §3-bis). The recipient never collects before
        // the physical pickup certifies the handoff.
        {
          kind: 'create_conditional_payment',
          purpose: 'claim_payment',
          payerId: ctx.senderId,
          payeeId: event.claimantId,
          amountMsat: event.claimPaymentMsat,
          ref,
        },
      ];
      if (event.hubBonusMsat > 0n) {
        // Π_h to the hub that completes the delivery (ADR-014's rationale,
        // applied to the claim): a zero share creates no hold.
        effects.push({
          kind: 'create_conditional_payment',
          purpose: 'finalization_bonus',
          payerId: ctx.senderId,
          payeeId: stay.hubUserId,
          amountMsat: event.hubBonusMsat,
          ref,
        });
      }
      effects.push(
        {
          kind: 'schedule_timeout',
          timeout: 'claim_funding',
          refId: event.claimId,
          at: event.fundingDeadlineAt,
        },
        {
          kind: 'append_custody_event',
          type: 'claim_requested',
          actorUserId: event.claimantId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: {
            claimId: event.claimId,
            claimPaymentMsat: event.claimPaymentMsat,
            hubBonusMsat: event.hubBonusMsat,
          },
        },
      );
      // Still AT_HUB, like an accepted-but-unfunded leg: CLAIMED only when
      // every hold is observed held. The pendingClaim in context is what
      // hides the shipment from the board meanwhile.
      return ok('AT_HUB', effects);
    }

    // ----------------------------------------------------------------- #19
    case 'claim_funded': {
      if (state !== 'AT_HUB') return illegal(state, event.type, 'claim_funded is legal only in AT_HUB');
      const stay = ctx.currentHubStay;
      const claim = ctx.pendingClaim;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (!claim) return guardFailed(state, event.type, 'no pending claim to fund');
      if (!withinDeadline(event.now, claim.fundingDeadlineAt)) {
        return guardFailed(state, event.type, 'claim funding window expired (60 min, ADR-016)');
      }
      const ref = claimRef(claim);
      const effects: ShipmentEffect[] = [
        // Every claim hold is now held: recognize the commitments (ADR-010).
        heldEntry('claim_payment_held', ref, ctx.senderId, ctx.shipmentId, claim.claimPaymentMsat),
      ];
      if (claim.hubBonusPaymentId) {
        effects.push(heldEntry('finalization_bonus_held', ref, ctx.senderId, ctx.shipmentId, claim.hubBonusMsat));
      }
      effects.push(
        { kind: 'cancel_timeout', timeout: 'claim_funding', refId: claim.claimId },
        // Storage does NOT pause (ADR-016): unlike a booked leg, the claim
        // keeps the parcel exactly where it is — the hub's shelf stays
        // occupied and the sender's chosen window keeps running.
        {
          kind: 'append_custody_event',
          type: 'funded',
          actorUserId: null, // wallet-observed event, no human actor
          legId: null,
          hubStayId: stay.hubStayId,
          payload: {
            claimId: claim.claimId,
            claimPaymentMsat: claim.claimPaymentMsat,
            hubBonusMsat: claim.hubBonusMsat,
          },
        },
      );
      return ok('CLAIMED', effects);
    }

    // ------------------------------------------------------ #19 (expiry arm)
    case 'claim_funding_expired': {
      if (state !== 'AT_HUB') {
        return illegal(state, event.type, 'claim_funding_expired is legal only in AT_HUB');
      }
      const claim = ctx.pendingClaim;
      if (!claim) return guardFailed(state, event.type, 'no pending claim to expire');
      if (!deadlinePassed(event.now, claim.fundingDeadlineAt)) {
        return guardFailed(state, event.type, 'claim funding window has not expired yet');
      }
      return ok('AT_HUB', [
        ...refundPendingClaimHolds(claim),
        {
          kind: 'append_custody_event',
          type: 'expired',
          actorUserId: null,
          legId: null,
          hubStayId: ctx.currentHubStay?.hubStayId ?? null,
          payload: { reason: 'claim_funding', claimId: claim.claimId },
        },
      ]);
    }

    // ----------------------------------------------------------------- #20
    case 'recipient_claimed_pickup': {
      if (state !== 'CLAIMED') {
        return illegal(state, event.type, 'recipient_claimed_pickup is legal only in CLAIMED');
      }
      const stay = ctx.currentHubStay;
      const claim = ctx.pendingClaim;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (!claim) return guardFailed(state, event.type, 'no funded claim in context');
      if (claim.hubStayId !== stay.hubStayId) {
        // The parcel cannot move while a claim is in flight (leg_accept is
        // barred): a mismatch means the context is incoherent, not a race.
        return guardFailed(state, event.type, 'claim was frozen against a different hub stay');
      }
      if (!event.claimTokenVerified) {
        return guardFailed(state, event.type, 'the claim token must be verified at the physical pickup');
      }
      const ref = claimRef(claim);
      const effects: ShipmentEffect[] = [
        // The hub certifies the handoff and the coordinator reveals the
        // preimages: the recipient collects pool + Π_v directly from the
        // sender; accepting the parcel is definitive (ADR-012, like the OTP).
        { kind: 'release_conditional_payment', paymentId: claim.claimPaymentId },
        settledEntry('claim_payment_released', ref, claim.claimantId, ctx.shipmentId, claim.claimPaymentMsat),
      ];
      if (claim.hubBonusPaymentId) {
        effects.push(
          { kind: 'release_conditional_payment', paymentId: claim.hubBonusPaymentId },
          settledEntry('finalization_bonus_released', ref, stay.hubUserId, ctx.shipmentId, claim.hubBonusMsat),
        );
      }
      effects.push(
        // The hub's custody ends with the handoff: its bond dissolves.
        { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
        refundedEntry(
          'hub_bond_refunded',
          stayRef(stay.hubStayId),
          stay.hubUserId,
          ctx.shipmentId,
          ctx.custodyBondMsat,
        ),
        { kind: 'cancel_timeout', timeout: 'storage', refId: stay.hubStayId },
        { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
        {
          kind: 'append_custody_event',
          type: 'recipient_claimed',
          actorUserId: stay.hubUserId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: { claimId: claim.claimId, claimTokenVerified: true },
        },
        // The sender learns the journey ended early — the claim's mirror of
        // the recipient_pickup confirmation (flow step 7).
        { kind: 'queue_email', to: 'sender', template: 'parcel_delivered', payload: {} },
      );
      return ok('DELIVERED', effects);
    }

    // ----------------------------------------------------------------- #12
    case 'handoff_reject': {
      // Documentary only (ADR-012): custody does NOT pass, the state does not
      // change, no money moves. The rejection is evidence plus a notification
      // to the sender, who can react with reroute/boost. The recipient_pickup
      // stage covers the claimed pickup too (ADR-016): same physical act, the
      // recipient collecting at the hub.
      const legalStage: Record<typeof event.stage, ShipmentState[]> = {
        pickup_checkout: ['LEG_BOOKED'],
        hub_checkin: ['IN_TRANSIT'],
        recipient_pickup: ['AWAITING_PICKUP', 'CLAIMED'],
      };
      if (state !== 'LEG_BOOKED' && state !== 'IN_TRANSIT' && state !== 'AWAITING_PICKUP' && state !== 'CLAIMED') {
        return illegal(state, event.type, 'handoff_reject is legal only at a physical handoff');
      }
      if (!legalStage[event.stage].includes(state)) {
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
      if (state !== 'AT_HUB' && state !== 'AWAITING_PICKUP' && state !== 'CLAIMED') {
        return illegal(state, event.type, 'storage_expiry is legal only in AT_HUB, AWAITING_PICKUP or CLAIMED');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no active hub stay in context');
      if (state === 'CLAIMED' && ctx.pendingClaim === null) {
        return guardFailed(state, event.type, 'CLAIMED requires the funded claim in context');
      }
      if (!deadlinePassed(event.now, stay.storageDeadlineAt)) {
        return guardFailed(state, event.type, 'storage deadline has not passed yet');
      }
      return ok('FORFEITED', [
        ...dissolvePendingOnForfeit(state, ctx),
        // A renewal reminder may still be armed on the stay (ADR-033).
        { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
        ...forfeitBondEffects(ctx, stay, 'storage'),
      ]);
    }

    // --------------------------------------------------------- (ADR-033)
    case 'bond_renew': {
      // Worker-only, fired by the bond_renewal timer: replace the current
      // stay's bond hold with the next 7-day window's hold — or, past the
      // window's end, treat the missed renewal as an early end of storage.
      if (
        state !== 'AWAITING_DROPOFF' &&
        state !== 'AT_HUB' &&
        state !== 'LEG_BOOKED' &&
        state !== 'AWAITING_PICKUP' &&
        state !== 'CLAIMED'
      ) {
        return illegal(state, event.type, 'bond_renew is legal only while a hub stay holds a live bond');
      }
      const stay = ctx.currentHubStay;
      if (!stay) return guardFailed(state, event.type, 'no current hub stay in context');
      if (stay.hubStayId !== event.hubStayId) {
        return guardFailed(state, event.type, 'bond_renew targets a stay that is no longer current');
      }
      if (!stay.bondWindowEndsAt) {
        // Legacy stay born under the 7-day cap: its single hold covers the
        // whole storage, nothing to renew — the timer dies as stale.
        return guardFailed(state, event.type, 'stay has no bond window: nothing to renew');
      }
      // An ACTIVE stay whose storage deadline falls inside the current window
      // needs no renewal: the bond dies with the stay first. Reserved stays
      // (AWAITING_DROPOFF) carry the epoch sentinel — no deadline yet, renew.
      const storageDeadline = epoch(stay.storageDeadlineAt);
      if (storageDeadline > 0 && storageDeadline <= epoch(stay.bondWindowEndsAt)) {
        return guardFailed(state, event.type, 'bond window already covers the storage deadline');
      }
      if (deadlinePassed(event.now, stay.bondWindowEndsAt) && state !== 'LEG_BOOKED') {
        // The window closed with no successful renewal: the hub declared by
        // facts that it no longer guarantees custody (ADR-026 §3, ADR-033 §3).
        // LEG_BOOKED is the deliberate exception: a carrier already has funds
        // bound and the pickup resolves the stay within hours — forfeiting
        // would punish carrier and sender for the hub's fault, so the machine
        // keeps attempting the renewal instead (the arm below).
        if (state === 'AWAITING_DROPOFF') {
          // The parcel is still with the sender: the reservation dissolves at
          // zero cost — nothing to forfeit, nothing to compensate.
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
              actorUserId: null,
              legId: null,
              hubStayId: stay.hubStayId,
              payload: { reason: 'bond_renewal' },
            },
            {
              kind: 'queue_email',
              to: 'sender',
              template: 'hub_bond_lapsed',
              payload: { hubId: stay.hubId, phase: 'dropoff' },
            },
          ]);
        }
        // AT_HUB / AWAITING_PICKUP / CLAIMED: an early storage expiry. Unlike
        // storage_expiry this consumes the bond_renewal timer (its own) and
        // must disarm the still-armed storage timer; the sender gets a mail
        // because no 72/24h warnings preceded this end (ADR-033 §3).
        return ok('FORFEITED', [
          ...dissolvePendingOnForfeit(state, ctx),
          { kind: 'cancel_timeout', timeout: 'storage', refId: stay.hubStayId },
          ...forfeitBondEffects(ctx, stay, 'bond_renewal'),
          {
            kind: 'queue_email',
            to: 'sender',
            template: 'hub_bond_lapsed',
            payload: { hubId: stay.hubId, phase: 'storage' },
          },
        ]);
      }
      const ref = stayRef(stay.hubStayId);
      return ok(state, [
        // The next window's hold FIRST: the executor waits until it is held
        // before anything commits (same path as origin_hub_accept), so there
        // is never an instant without a bonded custodian (invariant 4) —
        // the old hold is still in flight until the new one is observed.
        {
          kind: 'create_conditional_payment',
          purpose: 'custody_bond',
          payerId: stay.hubUserId,
          payeeId: ctx.senderId,
          amountMsat: ctx.custodyBondMsat,
          ref,
          // One idem key per renewal round; retries of the same round reuse it.
          idemNonce: event.newBondWindowEndsAt,
        },
        heldEntry('hub_bond_held', ref, stay.hubUserId, ctx.shipmentId, ctx.custodyBondMsat),
        // Only then the previous hold dissolves: the net bond commitment is
        // unchanged across the renewal (ADR-010).
        { kind: 'refund_conditional_payment', paymentId: stay.bondPaymentId },
        refundedEntry('hub_bond_refunded', ref, stay.hubUserId, ctx.shipmentId, ctx.custodyBondMsat),
        {
          kind: 'schedule_timeout',
          timeout: 'bond_renewal',
          refId: stay.hubStayId,
          at: isoMinusHours(event.newBondWindowEndsAt, BOND_RENEWAL_LEAD_HOURS),
        },
        {
          kind: 'append_custody_event',
          type: 'bond_renewed',
          actorUserId: stay.hubUserId,
          legId: null,
          hubStayId: stay.hubStayId,
          payload: {
            custodyBondMsat: ctx.custodyBondMsat,
            bondWindowEndsAt: event.newBondWindowEndsAt,
          },
        },
      ]);
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
      if (ctx.pendingClaim !== null) {
        // The claim froze its amounts; a boost would change the pool under it
        // (ADR-016). The sender can boost again once the claim resolves.
        return guardFailed(state, event.type, 'boost is rejected while a recipient claim is pending');
      }
      if (ctx.pendingLegRequest !== null) {
        // Same freeze rule (ADR-029): the request carries a frozen price; a
        // boost would change the pool under the hub's pending decision.
        return guardFailed(state, event.type, 'boost is rejected while a deposit request is pending');
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
      if (ctx.pendingClaim !== null) {
        // A reroute would re-freeze the pool and rotate the recipient's
        // credentials under a claim that already froze both (ADR-016).
        return guardFailed(state, event.type, 'reroute is rejected while a recipient claim is pending');
      }
      if (ctx.pendingLegRequest !== null) {
        // The request froze its price against the CURRENT route (ADR-029).
        return guardFailed(state, event.type, 'reroute is rejected while a deposit request is pending');
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
      if (event.newRecipientEmail !== null) {
        // The claim token is the OLD recipient's credential: rotate it and
        // hand the new recipient a fresh tracking mail (ADR-016) — the old
        // token can no longer claim anything.
        effects.push({ kind: 'rotate_claim_token' }, {
          kind: 'queue_email',
          to: 'recipient',
          template: 'parcel_tracking',
          payload: { hubId: stay.hubId },
        });
      }
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
          { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
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
        if (ctx.pendingClaim !== null) {
          return guardFailed(state, event.type, 'cancel is rejected while a recipient claim is pending');
        }
        if (ctx.pendingLegRequest !== null) {
          // Board-exclusive (ADR-029): the carrier holds a live option on the
          // parcel until the hub answers or the window closes (30 min).
          return guardFailed(state, event.type, 'cancel is rejected while a deposit request is pending');
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
          { kind: 'cancel_timeout', timeout: 'bond_renewal', refId: stay.hubStayId },
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
