// Shipment state machine types shared between @mercurio/core (the transition
// engine) and the API (which executes the effects in a single transaction).
// The engine itself lives in @mercurio/core/state-machine — pure functions
// only, and the ONLY source of money movements (ARCHITECTURE.md §5).

import type { LegPricing } from './economics';
import type { Msat, ShipmentState } from './index';

/** Funding window for the three per-leg hold invoices (ARCHITECTURE.md §5 row 5). */
export const LEG_FUNDING_WINDOW_MINUTES = 60;

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
  'handoff_rejected',
  'rerouted',
  'boosted',
  'expired',
  'cancelled',
] as const;
export type CustodyEventType = (typeof CUSTODY_EVENT_TYPES)[number];

/** Timer families the worker schedules on behalf of the state machine. */
export const TIMEOUT_KINDS = ['leg_funding', 'pickup', 'transit', 'storage'] as const;
export type TimeoutKind = (typeof TIMEOUT_KINDS)[number];

/** Notifications the docs prescribe (flow steps 6–7, table row 12). OTP and
 *  storage-deadline reminders are the worker's business, not transitions. */
export type EmailTemplate =
  | 'parcel_at_intermediate_hub'
  | 'parcel_arrived'
  | 'parcel_delivered'
  | 'handoff_rejected';

/** Effects address people by role; the API resolves the actual address.
 *  The recipient may not even have an account (identified by email only). */
export type EmailRecipientRole = 'sender' | 'recipient';

export type PaymentPurpose = 'leg_payment' | 'custody_bond' | 'finalization_bonus';

/** What a conditional payment (or fee) is attached to. */
export interface PaymentRef {
  type: 'leg' | 'hub_stay';
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
  | { kind: 'rotate_pickup_otp' };

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
  finalizationBonusHold: FinalizationBonusHold | null;
}

/**
 * The 17 protocol events of ARCHITECTURE.md §5 (leg_checkin covers both table
 * rows 8 and 9 — the guard on the check-in hub decides intermediate vs
 * destination) plus the explicit leg_funding_expired (the "finestra scaduta"
 * arm of row 5: money moves, so it must be a transition).
 * Ids for entities born in a transition (legs, hub stays) are minted by the
 * caller and passed in, keeping the function pure and the effects replayable.
 * Timestamps are ISO 8601 UTC strings; `now` is injected, never read from a
 * clock.
 */
export type ShipmentEvent =
  | { type: 'create' }
  | { type: 'origin_hub_accept'; hubStayId: string; hubWalletConnected: boolean }
  | { type: 'origin_checkin'; photoSha256: string[]; storageDeadlineAt: string }
  | {
      type: 'leg_accept';
      legId: string;
      carrierId: string;
      carrierWalletConnected: boolean;
      carrierTripActive: boolean;
      toHubId: string;
      toHubUserId: string;
      arrivalHubStayId: string;
      arrivalHubAutoAccepts: boolean;
      arrivalHubWalletConnected: boolean;
      pricing: LegPricing;
      /** Hub share Π_h of the finalization bonus to freeze into the fourth
       *  hold (ADR-014). MUST be 0 unless the leg delivers to the destination
       *  hub; may be 0 there too (share floored to 0, or already refrozen). */
      finalizationHubBonusMsat: Msat;
      fundingDeadlineAt: string;
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
