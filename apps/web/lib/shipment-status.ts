// Shipment state → UI meta (tone + i18n keys). The copy itself lives in
// messages/*.json under `statuses.<STATE>` so both locales stay complete —
// the unit test walks SHIPMENT_STATES against both catalogs.

import { SHIPMENT_STATES, type ShipmentState } from '@mercurio/shared';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const SHIPMENT_STATUS_TONE: Record<ShipmentState, StatusTone> = {
  DRAFT: 'neutral',
  AWAITING_DROPOFF: 'info',
  AT_HUB: 'info',
  LEG_BOOKED: 'info',
  IN_TRANSIT: 'info',
  AWAITING_PICKUP: 'warning',
  CLAIMED: 'warning',
  DELIVERED: 'success',
  CANCELLED: 'neutral',
  FORFEITED: 'danger',
  LOST: 'danger',
};

/** i18n key of the short label, under the `statuses` namespace. */
export function statusLabelKey(state: ShipmentState): string {
  return `${state}.label`;
}

/** i18n key of the one-line explanation, under the `statuses` namespace. */
export function statusDescriptionKey(state: ShipmentState): string {
  return `${state}.description`;
}

/** Sender actions the UI OFFERS per state; the API remains the judge (its
 *  guards also weigh live claims and booked legs the client cannot see). */
export const SENDER_ACTIONS: Record<
  ShipmentState,
  ReadonlyArray<'boost' | 'reroute' | 'cancel'>
> = {
  DRAFT: ['cancel'],
  AWAITING_DROPOFF: ['cancel'],
  AT_HUB: ['boost', 'reroute', 'cancel'],
  LEG_BOOKED: [],
  IN_TRANSIT: [],
  AWAITING_PICKUP: ['boost', 'reroute'],
  CLAIMED: [],
  DELIVERED: [],
  CANCELLED: [],
  FORFEITED: [],
  LOST: [],
};

/** Closed shipment (ADR-017): ALL terminal states admit reviews, not just
 *  DELIVERED — mirrors `isTerminalState` in @mercurio/core (the web depends
 *  only on @mercurio/shared, so the four states are restated here). */
const TERMINAL_STATES: ReadonlySet<ShipmentState> = new Set([
  'DELIVERED',
  'CANCELLED',
  'FORFEITED',
  'LOST',
]);

export function isTerminal(state: ShipmentState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Custody event types with dedicated copy (`custody.<type>` keys); unknown
 *  types fall back to the raw string so new events degrade readably. */
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
  'claim_requested',
  'recipient_claimed',
] as const;

export { SHIPMENT_STATES };
export type { ShipmentState };
