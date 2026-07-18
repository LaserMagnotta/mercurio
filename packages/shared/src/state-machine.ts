// Shipment state machine types shared between @mercurio/core (the transition
// engine) and the API (which executes the effects in a single transaction).
// The engine itself lives in @mercurio/core/state-machine — pure functions
// only, and the ONLY source of money movements (ARCHITECTURE.md §5).

import type { LegPricing } from './economics.js';
import type { Msat, ShipmentState } from './index.js';

/** Funding window for the three per-leg hold invoices (ARCHITECTURE.md §5 row 5). */
export const LEG_FUNDING_WINDOW_MINUTES = 60;

/** How long a manual arrival hub has to answer a deposit request (ADR-029,
 *  decisione A): wall-clock, same family as the funding window. While the
 *  request is pending the shipment is off the board, so the window is short —
 *  the carrier can cancel and re-target sooner. */
export const DEPOSIT_RESPONSE_WINDOW_MINUTES = 30;

/**
 * MVP deadline policy (ARCHITECTURE.md §5 leaves the durations open; these
 * constants freeze the simplest workable choice, documented in the
 * "Precisazioni implementative"). All deadlines are computed by the API when
 * it fires the transition and frozen on the row — the machine only compares.
 */
/** From leg_funded to the physical pickup at the ceding hub (row 7). */
export const PICKUP_WINDOW_HOURS = 24;
/** From pickup_checkout to the check-in at the arrival hub (row 14). */
export const TRANSIT_WINDOW_HOURS = 48;
/** Both halves of the double-confirmation checkout must land within this
 *  window of each other (ARCHITECTURE.md §7: "entro la stessa finestra"). */
export const CHECKOUT_CONFIRMATION_WINDOW_MINUTES = 15;

/**
 * Custody-chain event types — mirrors the Postgres enum `custody_event_type`
 * (packages/db/src/schema/enums.ts). Every state transition appends exactly
 * one of these (ARCHITECTURE.md §5: "ogni transizione è un evento della
 * catena di custodia").
 */
export const CUSTODY_EVENT_TYPES = [
  'created',
  'funded',
  'hub_checkin',
  'leg_accepted',
  'hub_checkout',
  'hub_checkin_intermediate',
  'leg_returned',
  'arrived_destination',
  'recipient_pickup',
  'claim_requested',
  'recipient_claimed',
  'handoff_rejected',
  'rerouted',
  'boosted',
  'expired',
  'cancelled',
  // ADR-029 (appended: enum values only ever ADD). Only the REQUEST gets a
  // new type; the accept reuses 'leg_accepted', reject reuses
  // 'handoff_rejected' (same primitive: the receiving party declines) and
  // expiry/cancel reuse 'expired' with a payload reason.
  'deposit_requested',
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

/** Timer families the worker schedules on behalf of the state machine.
 *  'deposit_response' (appended, ADR-029) is the manual arrival hub's answer
 *  window, armed at leg_request and disarmed by the hub's answer. */
export const TIMEOUT_KINDS = [
  'leg_funding',
  'pickup',
  'transit',
  'storage',
  'claim_funding',
  'deposit_response',
] as const;
export type TimeoutKind = (typeof TIMEOUT_KINDS)[number];

/** Notifications the docs prescribe (flow steps 6–7, table row 12; tracking
 *  mail with the claim token — ADR-016; deposit-request outcome to the
 *  carrier — ADR-029 "il vettore è avvisato e sceglie un altro hub"). OTP and
 *  storage-deadline reminders are the worker's business, not transitions. */
export type EmailTemplate =
  | 'parcel_tracking'
  | 'parcel_at_intermediate_hub'
  | 'parcel_arrived'
  | 'parcel_delivered'
  | 'handoff_rejected'
  | 'deposit_request_rejected';

/** Effects address people by role; the API resolves the actual address.
 *  The recipient may not even have an account (identified by email only).
 *  'carrier' is the requester of the pending deposit request (ADR-029). */
export type EmailRecipientRole = 'sender' | 'recipient' | 'carrier';

export type PaymentPurpose = 'leg_payment' | 'custody_bond' | 'finalization_bonus' | 'claim_payment';

/** What a conditional payment (or fee) is attached to. 'claim' points at a
 *  shipment_claims row (ADR-016): both claim holds reference the claim, so
 *  their idempotency keys can never collide with the hub-stay-referenced
 *  Π_h hold of an earlier final leg. */
export interface PaymentRef {
  type: 'leg' | 'hub_stay' | 'claim';
  id: string;
}

export type LedgerRef = PaymentRef | { type: 'shipment'; id: string };

/**
 * One signed posting of a shadow-ledger journal entry (ADR-010). Account
 * descriptors, not account ids: the API resolves them via findOrCreateAccount.
 * By construction no descriptor can name the platform — owners are always a
 * user's external wallet or a shipment's commitment bucket (invariant 1).
 */
export interface LedgerPosting {
  ownerType: 'user' | 'shipment';
  ownerId: string;
  accountKind: 'external_wallet' | 'commitment';
  amountMsat: Msat;
}

/**
 * Declarative effects — pure DATA, never I/O. The API executes the whole list
 * in one transaction; if any step fails the transition never happened.
 * Payment effects reference conditional payments by the id the API assigned
 * when it executed the corresponding create effect (carried back via ctx).
 */
export type ShipmentEffect =
  /** Open a hold invoice payee→payer (ESCROW.md §2–3). The transition commits
   *  only once the wallet reports the hold as held. */
  | {
      kind: 'create_conditional_payment';
      purpose: PaymentPurpose;
      payerId: string;
      payeeId: string;
      amountMsat: Msat;
      ref: PaymentRef;
    }
  /** Reveal the preimage to the payee: they collect directly from the payer. */
  | { kind: 'release_conditional_payment'; paymentId: string }
  /** Cancel the hold: funds return to the payer, untouched. */
  | { kind: 'refund_conditional_payment'; paymentId: string }
  /** On-the-spot instant invoice (hub fees, cancellation compensation).
   *  Certification is unlocked by the payment (ESCROW.md §3). */
  | {
      kind: 'request_instant_payment';
      payerId: string;
      payeeId: string;
      amountMsat: Msat;
      reason: 'dep_hub_fee' | 'arr_hub_fee' | 'cancellation_compensation';
      ref: LedgerRef;
    }
  /** Shadow-ledger journal entry; postings always sum to zero (ADR-010). */
  | {
      kind: 'post_ledger_entry';
      eventType: string;
      ref: LedgerRef;
      postings: LedgerPosting[];
    }
  /** Append to the hash-chained custody chain. The API computes the hash with
   *  custodyEventHash() from the previous row. Payloads carry NO direct PII
   *  (the chain is immutable; GDPR erasure must not break it — RISKS.md §6). */
  | {
      kind: 'append_custody_event';
      type: CustodyEventType;
      actorUserId: string | null;
      legId: string | null;
      hubStayId: string | null;
      payload: Record<string, unknown>;
    }
  /** Queue in email_outbox within the same transaction (outbox pattern). */
  | { kind: 'queue_email'; to: EmailRecipientRole; template: EmailTemplate; payload: Record<string, unknown> }
  | { kind: 'schedule_timeout'; timeout: TimeoutKind; refId: string; at: string }
  | { kind: 'cancel_timeout'; timeout: TimeoutKind; refId: string }
  /** Invalidate and reissue the recipient pickup OTP (ARCHITECTURE.md row 16). */
  | { kind: 'rotate_pickup_otp' }
  /** Invalidate and reissue the recipient claim token (ADR-016): minted at
   *  origin_checkin, rotated by a recipient-changing reroute. Only the hash
   *  touches the DB; the plaintext rides in the tracking email queued by the
   *  same transition (same pattern as the pickup OTP). */
  | { kind: 'rotate_claim_token' };

/**
 * The hub stay whose custody bond currently backs the parcel. Non-null from
 * AWAITING_DROPOFF (reserved at origin_hub_accept) through LEG_BOOKED, null
 * while IN_TRANSIT (the carrier is the custodian), non-null again from
 * check-in / AWAITING_PICKUP.
 */
export interface ActiveHubStay {
  hubStayId: string;
  hubId: string;
  /** The hub owner — payments are always between users (ADR-013). */
  hubUserId: string;
  /** Conditional payment id of the hub's custody bond. */
  bondPaymentId: string;
  /** Storage deadline of this stay (ISO 8601 UTC). Kept here so pickup_timeout
   *  can re-arm the storage timer with the ORIGINAL deadline. */
  storageDeadlineAt: string;
}

/**
 * The pending (AT_HUB after leg_accept), booked (LEG_BOOKED) or picked-up
 * (IN_TRANSIT) leg. The three conditional-payment ids exist from the moment
 * the API executed the leg_accept create effects, whatever their hold state.
 */
export interface ActiveLeg {
  legId: string;
  carrierId: string;
  fromHubId: string;
  fromHubUserId: string;
  toHubId: string;
  toHubUserId: string;
  /** Reserved stay at the arrival hub (its bond is hold #3, ESCROW.md §3). */
  arrivalHubStayId: string;
  /** Amounts frozen at acceptance (ECONOMICS.md). */
  pricing: LegPricing;
  legPaymentId: string;
  carrierBondId: string;
  arrivalHubBondId: string;
  fundingDeadlineAt: string;
  /** Set when the leg is funded (LEG_BOOKED). */
  pickupDeadlineAt: string | null;
  /** Set at pickup_checkout (IN_TRANSIT). */
  transitDeadlineAt: string | null;
}

/**
 * Everything the pure transition needs to know about the shipment aggregate.
 * The API builds it from DB rows; authorization (sessions, QR scan, OTP hash
 * check) happens BEFORE calling the machine — the machine validates protocol
 * guards on facts the caller declares.
 */
/**
 * The pending hub share Π_h of the finalization bonus (ADR-014): a hold
 * sender → destination-hub user, created in the final leg's funding window
 * and released only at recipient_pickup (the carrier share Π_v travels inside
 * the final leg-payment hold instead). Non-null from the final leg's
 * acceptance until the hold is settled or cancelled.
 */
export interface FinalizationBonusHold {
  paymentId: string;
  amountMsat: Msat;
}

/**
 * The recipient claim in flight (ADR-016) — the claim's mirror of ActiveLeg.
 * Non-null from recipient_claim (holds created, funding window armed) until
 * the claim is settled (recipient_claimed_pickup), expired
 * (claim_funding_expired) or dissolved by storage_expiry. While set, the
 * shipment is off the board and every leg_accept is rejected.
 */
export interface PendingClaim {
  claimId: string;
  /** The recipient's user account — the claim payment's payee (ADR-013:
   *  payments are always between users, so claiming requires an account). */
  claimantId: string;
  /** The stay the pickup will happen at (custody does not move on a claim). */
  hubStayId: string;
  /** Frozen at the claim (ECONOMICS.md §5-ter): floorToSat(remaining work
   *  pool) + floorToSat(accrued unconsumed Π_v). */
  claimPaymentMsat: Msat;
  /** Frozen accrued Π_h for the pickup hub; 0 when it floored to nothing
   *  (then no hold exists and hubBonusPaymentId is null). */
  hubBonusMsat: Msat;
  claimPaymentId: string;
  hubBonusPaymentId: string | null;
  fundingDeadlineAt: string;
}

/**
 * A deposit request pending on a MANUAL arrival hub (ADR-029) — the money-free
 * phase before deposit_accept creates the holds. Non-null from leg_request
 * until the hub answers (deposit_accept → ActiveLeg takes over) or the request
 * dissolves (deposit_reject / deposit_request_expired / deposit_request_cancel).
 * While set, the shipment is off the board and leg_request / recipient_claim /
 * boost / reroute / cancel are all rejected (decisione C — board-exclusive,
 * like a pending claim). NO conditional payment exists in this phase: a
 * request that dies liquidates exactly zero msat.
 */
export interface PendingLegRequest {
  legId: string;
  carrierId: string;
  fromHubId: string;
  fromHubUserId: string;
  toHubId: string;
  toHubUserId: string;
  /** Amounts frozen at the REQUEST (ADR-029: the carrier sees what they would
   *  collect before the hub answers); deposit_accept freezes nothing new. */
  pricing: LegPricing;
  /** Frozen hub share Π_h for a final leg (0n otherwise) — recorded in the
   *  deposit_requested chain event; the 4th hold's amount at accept. */
  finalizationHubBonusMsat: Msat;
  responseDeadlineAt: string;
}

export interface ShipmentContext {
  shipmentId: string;
  senderId: string;
  senderWalletConnected: boolean;
  originHubId: string;
  originHubUserId: string;
  destHubId: string;
  /** The single custody bond required from whoever holds the parcel (§6). */
  custodyBondMsat: Msat;
  /** Current segment commitment (the sender's offer P for the first segment;
   *  informational — recorded in the custody chain at create). */
  offerMsat: Msat;
  /** Current segment WORK-pool commitment (ADR-014): splitCommitment(P)
   *  .workMsat on the first segment, the frozen pool itself after a reroute.
   *  The cancel compensation is f_o × this amount — the finalization bonus is
   *  excluded from every other formula. */
  workCommitmentMsat: Msat;
  /** Origin hub fee f_o in integer basis points (hubFeePercentToBp). */
  originHubFeeBp: number;
  currentHubStay: ActiveHubStay | null;
  leg: ActiveLeg | null;
  /** The pending Π_h hold of a final LEG (ADR-014). A claim's hub-bonus hold
   *  lives in pendingClaim instead — the two never alias (ADR-016). */
  finalizationBonusHold: FinalizationBonusHold | null;
  pendingClaim: PendingClaim | null;
  /** The deposit request awaiting the arrival hub's answer (ADR-029).
   *  Mutually exclusive with `leg` and `pendingClaim` by machine guards. */
  pendingLegRequest: PendingLegRequest | null;
}

/**
 * The protocol events of ARCHITECTURE.md §5 (leg_checkin covers both table
 * rows 8 and 9 — the guard on the check-in hub decides intermediate vs
 * destination) plus the explicit leg_funding_expired (the "finestra scaduta"
 * arm of row 5: money moves, so it must be a transition) plus the four
 * recipient-claim events of ADR-016 (rows 18–21), which mirror the leg
 * funding cycle: request → funded/expired → physical pickup.
 *
 * ADR-029 split table row 4 in two: `leg_request` (carrier; freezes the price,
 * moves NO money, arms the response window) and `deposit_accept` (arrival hub;
 * exactly the old leg_accept's effect — creates the holds and arms funding).
 * An auto_accept hub is a pre-consent: the API fires deposit_accept right
 * after leg_request, preserving today's behavior. The negative outcomes
 * (deposit_reject / deposit_request_expired / deposit_request_cancel) dissolve
 * the request at zero cost and put the shipment back on the board.
 *
 * Ids for entities born in a transition (legs, hub stays) are minted by the
 * caller and passed in, keeping the function pure and the effects replayable.
 * Timestamps are ISO 8601 UTC strings; `now` is injected, never read from a
 * clock.
 */
export type ShipmentEvent =
  // The sender's optional creation photos (ADR-022): hashed on device like
  // every other photo (ADR-020 §2), certified by the `created` chain event.
  // Two distinct keys because one event certifies two kinds (content/sealed).
  | { type: 'create'; contentPhotoSha256?: string[]; sealedPhotoSha256?: string[] }
  | { type: 'origin_hub_accept'; hubStayId: string; hubWalletConnected: boolean }
  | { type: 'origin_checkin'; photoSha256: string[]; storageDeadlineAt: string }
  | {
      /** ADR-029: the carrier asks the arrival hub to host the parcel. The
       *  price is frozen HERE (the carrier must see what they would collect)
       *  but no hold exists until deposit_accept — a dissolved request costs
       *  zero. The old "hub must auto-accept" guard is gone: only a connected
       *  wallet is required (the hub must be ABLE to bond, if it accepts). */
      type: 'leg_request';
      legId: string;
      carrierId: string;
      carrierWalletConnected: boolean;
      carrierTripActive: boolean;
      toHubId: string;
      toHubUserId: string;
      arrivalHubWalletConnected: boolean;
      pricing: LegPricing;
      /** Hub share Π_h of the finalization bonus, frozen at the request and
       *  bound into the fourth hold at deposit_accept (ADR-014). MUST be 0
       *  unless the leg delivers to the destination hub; may be 0 there too
       *  (share floored to 0, or already refrozen). */
      finalizationHubBonusMsat: Msat;
      responseDeadlineAt: string;
    }
  | {
      /** ADR-029: the arrival hub says yes — exactly the old leg_accept's
       *  effect: the 3–4 holds are created, the funding window is armed, the
       *  chain records `leg_accepted`. The stay id is minted now (the stay is
       *  born with its bond hold, like every other stay). */
      type: 'deposit_accept';
      now: string;
      arrivalHubStayId: string;
      arrivalHubWalletConnected: boolean;
      fundingDeadlineAt: string;
    }
  | {
      /** ADR-029: the arrival hub says no. Documentation, not a judgment
       *  (ADR-012): a rejections row (stage deposit_request) plus the chain
       *  event; zero holds ever existed, zero money moves. */
      type: 'deposit_reject';
      /** The hub owner filing the refusal (chain actor + rejections row). */
      rejectedById: string;
      reason: string;
    }
  | {
      /** ADR-029: the response window elapsed with no answer (worker). */
      type: 'deposit_request_expired';
      now: string;
    }
  | {
      /** ADR-029: the carrier withdraws the request to re-target quickly. */
      type: 'deposit_request_cancel';
    }
  | { type: 'leg_funded'; now: string; pickupDeadlineAt: string }
  | { type: 'leg_funding_expired'; now: string }
  | {
      type: 'pickup_checkout';
      now: string;
      hubConfirmed: boolean;
      carrierConfirmed: boolean;
      photoSha256: string[];
      transitDeadlineAt: string;
    }
  | { type: 'pickup_timeout'; now: string }
  | {
      type: 'leg_checkin';
      now: string;
      hubId: string;
      integrityConfirmed: boolean;
      photoSha256: string[];
      storageDeadlineAt: string;
    }
  | {
      type: 'leg_return';
      now: string;
      hubId: string;
      returnHubStayId: string;
      photoSha256: string[];
      storageDeadlineAt: string;
    }
  | { type: 'recipient_pickup'; otpVerified: boolean }
  | {
      /** ADR-016 row 18: the recipient claims the idle parcel. Amounts are
       *  frozen by the caller with the pure pricing engine (priceClaim), like
       *  leg_accept freezes its LegPricing; the machine validates the guards
       *  and owns every resulting movement. */
      type: 'recipient_claim';
      claimId: string;
      claimantId: string;
      claimantWalletConnected: boolean;
      /** The API verified the bearer claim-token hash (precisazione 10:
       *  authorization outside the machine, facts inside). */
      claimTokenVerified: boolean;
      claimPaymentMsat: Msat;
      hubBonusMsat: Msat;
      fundingDeadlineAt: string;
    }
  | { type: 'claim_funded'; now: string }
  | { type: 'claim_funding_expired'; now: string }
  | { type: 'recipient_claimed_pickup'; claimTokenVerified: boolean }
  | {
      type: 'handoff_reject';
      stage: 'pickup_checkout' | 'hub_checkin' | 'recipient_pickup';
      rejectedById: string | null;
      reason: string;
      photoSha256: string[];
    }
  | { type: 'storage_expiry'; now: string }
  | { type: 'transit_timeout'; now: string }
  | { type: 'boost'; amountMsat: Msat; atRemainingKm: number }
  | {
      type: 'reroute';
      newDestHubId: string | null;
      newDestHubUserId: string | null;
      newRecipientEmail: string | null;
      newRemainingKm: number;
    }
  | { type: 'cancel' };

export type ShipmentEventType = ShipmentEvent['type'];

export type TransitionErrorCode =
  /** The event is not legal in this state (or the state is terminal). */
  | 'illegal_event'
  /** Right state, but a guard from the §5 table failed. */
  | 'guard_failed';

export interface TransitionError {
  code: TransitionErrorCode;
  state: ShipmentState | null;
  event: ShipmentEventType;
  message: string;
}

export type TransitionResult =
  | { ok: true; nextState: ShipmentState; effects: ShipmentEffect[] }
  | { ok: false; error: TransitionError };
