// Postgres enum types backing the state machine (ARCHITECTURE.md sec.5) and
// the non-custodial payment flow (ADR-013). Values are the lowercase wire
// form; TypeScript-side unions in @mercurio/shared use the matching
// UPPER_CASE form for the shipment lifecycle (ARCHITECTURE.md states) and
// this lowercase form for everything else, to keep Postgres enum literals
// conventional.
import { pgEnum } from 'drizzle-orm/pg-core';

// 'claimed' (appended: enum values only ever ADD) is the recipient claim's
// mirror of leg_booked — claim holds funded, pickup pending (ADR-016).
export const shipmentStatusEnum = pgEnum('shipment_status', [
  'draft',
  'awaiting_dropoff',
  'at_hub',
  'leg_booked',
  'in_transit',
  'awaiting_pickup',
  'delivered',
  'cancelled',
  'forfeited',
  'lost',
  'claimed',
]);

export const legStatusEnum = pgEnum('leg_status', [
  'pending_funding',
  'booked',
  'picked_up',
  'completed',
  'returned',
  'expired',
  'failed',
]);

export const hubStayStatusEnum = pgEnum('hub_stay_status', [
  'reserved',
  'active',
  'released',
  'expired',
]);

export const custodyEventTypeEnum = pgEnum('custody_event_type', [
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
  // ADR-016 (appended: enum values only ever ADD).
  'claim_requested',
  'recipient_claimed',
]);

export const photoKindEnum = pgEnum('photo_kind', [
  'content',
  'sealed',
  'checkin',
  'checkout',
  'evidence',
]);

export const rejectionStageEnum = pgEnum('rejection_stage', [
  'hub_checkin',
  'pickup_checkout',
  'recipient_pickup',
]);

// Wallet connection (ESCROW.md sec.5): the user's own wallet, never the platform's.
export const walletKindEnum = pgEnum('wallet_kind', ['nwc', 'lnd_rest', 'fake']);
export const walletStatusEnum = pgEnum('wallet_status', ['connected', 'disconnected', 'error']);

// Conditional payments (hold invoices) are the only "hold" primitive in the
// system (ADR-013): no platform-held escrow accounts exist.
// 'finalization_bonus' is the hub share of the ADR-014 bonus (sender -> dest
// hub, released at recipient_pickup); the carrier share needs no purpose of
// its own because it rides inside the final 'leg_payment' hold.
// 'claim_payment' is the recipient claim's hold (ADR-016): sender -> claimant,
// remaining work pool + unconsumed carrier bonus, released at the pickup.
export const conditionalPaymentPurposeEnum = pgEnum('conditional_payment_purpose', [
  'leg_payment',
  'custody_bond',
  'finalization_bonus',
  'claim_payment',
]);
export const conditionalPaymentStateEnum = pgEnum('conditional_payment_state', [
  'created',
  'held',
  'settled',
  'cancelled',
  'expired',
]);
// 'claim' points at a shipment_claims row: the claim's holds reference the
// claim itself, never the hub stay, so their idempotency keys cannot collide
// with a hub-stay-referenced hold of an earlier final leg (ADR-016).
export const conditionalPaymentRefTypeEnum = pgEnum('conditional_payment_ref_type', [
  'leg',
  'hub_stay',
  'claim',
]);

// One row per recipient claim (ADR-016): the frozen amounts and outcome —
// pending_funding -> funded (CLAIMED) -> completed, or -> expired when the
// funding window or the storage deadline dissolves it.
export const shipmentClaimStatusEnum = pgEnum('shipment_claim_status', [
  'pending_funding',
  'funded',
  'completed',
  'expired',
]);

// Shadow ledger (ADR-010): tracks commitments/settlements observed on external
// wallets. No account kind here can ever represent a platform-owned balance.
export const accountOwnerTypeEnum = pgEnum('account_owner_type', ['user', 'shipment']);
export const accountKindEnum = pgEnum('account_kind', ['external_wallet', 'commitment']);

// Timer facts for the state machine's deadlines (ADR-011). Rows are written
// in the SAME transaction as the transition that opens the deadline; a
// pg-boss sweep fires the due ones. Values mirror TIMEOUT_KINDS in
// @mercurio/shared.
export const shipmentTimerKindEnum = pgEnum('shipment_timer_kind', [
  'leg_funding',
  'pickup',
  'transit',
  'storage',
  'claim_funding',
]);

// On-the-spot instant payments (hub fees, cancellation compensation —
// ESCROW.md sec.3): normal invoices payee-issued and payer-paid at the
// physical handoff. Tracked so a retried transition never pays twice.
export const instantPaymentReasonEnum = pgEnum('instant_payment_reason', [
  'dep_hub_fee',
  'arr_hub_fee',
  'cancellation_compensation',
]);
export const instantPaymentStateEnum = pgEnum('instant_payment_state', ['created', 'settled']);

// Pending coordinator verbs (release/refund) queued by the effect executor:
// executed right after the transition commits and retried by a worker until
// they stick — both verbs are idempotent (ADR-013).
export const escrowIntentVerbEnum = pgEnum('escrow_intent_verb', ['release', 'refund']);

export const reviewRoleEnum = pgEnum('review_role', ['sender', 'carrier', 'hub']);

export const emailStatusEnum = pgEnum('email_status', ['pending', 'sent', 'failed']);

export const carrierTripStatusEnum = pgEnum('carrier_trip_status', [
  'active',
  'expired',
  'cancelled',
]);

// Auth (ADR-009): magic-link email is mandatory, LNURL-auth optional.
export const authMethodEnum = pgEnum('auth_method', ['magic_link', 'lnurl']);

// GDPR consent (RISKS.md sec.6).
export const consentTypeEnum = pgEnum('consent_type', ['tos', 'privacy_policy']);
