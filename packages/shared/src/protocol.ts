// Protocol-level constants and enums, in a LEAF module on purpose: api.ts
// consumes these as VALUES while building its zod schemas at module scope,
// and importing them from the './index' barrel (which re-exports api.ts)
// would be a circular value import — under the CJS-style transforms of the
// toolchain the constant reads as `undefined` at evaluation time, silently
// disabling the checks built on it (a z.number().max(undefined) never
// fires). Types may circle through the barrel freely; runtime values used
// by schemas must come from here.

/** Shipment lifecycle states (ARCHITECTURE.md §5). CLAIMED is the recipient
 *  claim's mirror of LEG_BOOKED (ADR-016): claim holds funded, parcel waiting
 *  for the claimant's physical pickup at the hub it already sits at. */
export const SHIPMENT_STATES = [
  'DRAFT',
  'AWAITING_DROPOFF',
  'AT_HUB',
  'LEG_BOOKED',
  'IN_TRANSIT',
  'AWAITING_PICKUP',
  'CLAIMED',
  'DELIVERED',
  'CANCELLED',
  'FORFEITED',
  'LOST',
] as const;
export type ShipmentState = (typeof SHIPMENT_STATES)[number];

/** Conditional payment (hold invoice) states — ADR-013. */
export const CONDITIONAL_PAYMENT_STATES = [
  'created',
  'held',
  'settled',
  'cancelled',
  'expired',
] as const;
export type ConditionalPaymentState = (typeof CONDITIONAL_PAYMENT_STATES)[number];

/** MVP cap: max storage per hub stay, bounded by the CLTV budget of the
 *  hub-bond hold invoice (ESCROW.md §4). */
export const MAX_STORAGE_HOURS = 7 * 24;

/** ToS cap on declared parcel value, in EUR (RISKS.md §2). */
export const MAX_DECLARED_VALUE_EUR = 45;

/** Cap on the custody bond, in EUR (RISKS.md §2). */
export const MAX_CUSTODY_BOND_EUR = 1000;

/** Per-role review subjects (CLAUDE.md "Recensioni": rating separato per
 *  ruolo — mirrors the Postgres enum `review_role`). */
export const REVIEW_ROLES = ['sender', 'carrier', 'hub'] as const;
export type ReviewRole = (typeof REVIEW_ROLES)[number];

/** Reviews are accepted from the shipment's closure (terminal custody event)
 *  up to this many days after it (ADR-017) — aligned with the photo
 *  retention window (closure + 30 days, RISKS.md §6): the documentation and
 *  the judgment about one shipment share a lifecycle. */
export const REVIEW_WINDOW_DAYS = 30;
