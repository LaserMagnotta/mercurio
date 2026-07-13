// Postgres enum types backing the state machine (ARCHITECTURE.md sec.5) and
// the non-custodial payment flow (ADR-013). Values are the lowercase wire
// form; TypeScript-side unions in @mercurio/shared use the matching
// UPPER_CASE form for the shipment lifecycle (ARCHITECTURE.md states) and
// this lowercase form for everything else, to keep Postgres enum literals
// conventional.
import { pgEnum } from 'drizzle-orm/pg-core';

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
export const conditionalPaymentPurposeEnum = pgEnum('conditional_payment_purpose', [
  'leg_payment',
  'custody_bond',
  'finalization_bonus',
]);
export const conditionalPaymentStateEnum = pgEnum('conditional_payment_state', [
  'created',
  'held',
  'settled',
  'cancelled',
  'expired',
]);
export const conditionalPaymentRefTypeEnum = pgEnum('conditional_payment_ref_type', [
  'leg',
  'hub_stay',
]);

// Shadow ledger (ADR-010): tracks commitments/settlements observed on external
// wallets. No account kind here can ever represent a platform-owned balance.
export const accountOwnerTypeEnum = pgEnum('account_owner_type', ['user', 'shipment']);
export const accountKindEnum = pgEnum('account_kind', ['external_wallet', 'commitment']);

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
