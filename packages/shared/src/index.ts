// @mercurio/shared — types, Zod schemas and constants shared across the monorepo.
// Domain types live here so web, api and core never drift apart.

/** All monetary amounts are millisatoshi (Lightning's native unit, ADR-008). */
export type Msat = bigint;

export * from './economics';
export * from './matching';
export * from './state-machine';
export * from './api';

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
