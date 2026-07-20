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

/** Max storage per hub stay, in DAYS (ADR-026 Parte 2). The hub bond renews
 *  rolling in ≤7-day hold windows (ADR-033), so no single HTLC ever spans the
 *  stay: the cap is a product choice now, not a CLTV budget — the Lightning
 *  constraint lives in BOND_RENEWAL_WINDOW_DAYS instead. */
export const MAX_STORAGE_DAYS = 30;

/** Canonical shape of a shipment codename: "Animale-Aggettivo-123" (Fase 1
 *  punto 1). Both lists are pure ASCII, so a codename is always URL/email safe.
 *  The generator and its curated word lists live in @mercurio/core; this is the
 *  shared validation contract (the API DTOs and the core generator both anchor
 *  to it). A codename is a LABEL, never a credential — nothing authorizes on
 *  it (ARCHITECTURE.md §7). */
export const CODENAME_PATTERN = /^[A-Z][a-z]+-[A-Z][a-z]+-\d{3}$/;

/** ToS cap on declared parcel value, in EUR (RISKS.md §2). */
export const MAX_DECLARED_VALUE_EUR = 45;

/** Storage-expiry warning emails (RISKS.md §4, ToS §10.1): sender and
 *  recipient are warned when the armed `storage` timer is within these many
 *  hours of firing. Order matters: most-lenient first, the sweep picks the
 *  most urgent threshold still unsent. */
export const STORAGE_WARNING_HOURS = [72, 24] as const;

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

/** Carrier trip status (mirrors the Postgres enum `carrier_trip_status`). A
 *  trip row is written once and never updated by any transition: routes
 *  treat "active" as `status === 'active' && expiresAt > now` (MATCHING.md
 *  §1) rather than trusting a stale column. */
export const CARRIER_TRIP_STATUSES = ['active', 'expired', 'cancelled'] as const;
export type CarrierTripStatus = (typeof CARRIER_TRIP_STATUSES)[number];

/** Simple offset pagination defaults for GET /me/* list endpoints
 *  (ADR-018 §5: the account is now the source of a user's own shipments and
 *  trips, not the device). */
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 100;

/** Photo blob upload cap in bytes (ADR-020). The first-party client
 *  re-encodes on-device (max 2048 px, JPEG) so real uploads sit well below
 *  this; the cap bounds what a third-party API client can push. */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** Retention window after the shipment's closure (RISKS.md §6: "chiusura
 *  spedizione + 30 giorni") — the purge worker tightens each photo's
 *  `purge_after` to closure + this once the shipment is terminal (ADR-020). */
export const PHOTO_RETENTION_DAYS_AFTER_CLOSURE = 30;

/** Hard ceiling from upload time, covering shipments that never close:
 *  `purge_after` is born at upload + this many days (ADR-020 §5). */
export const PHOTO_MAX_RETENTION_DAYS = 90;

/** Photo kinds (mirrors the Postgres enum `photo_kind`). `content`/`sealed`
 *  are the sender's creation photos, certified by the `created` custody
 *  event (ADR-022); the handoff kinds map from custody events (ADR-020 §3);
 *  `hub_venue` is the hub's own storefront photo, public and shipment-less
 *  (ADR-028) — it lives in `hub_photos`, never in the shipment `photos` table. */
export const PHOTO_KINDS = [
  'content',
  'sealed',
  'checkin',
  'checkout',
  'evidence',
  'hub_venue',
] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];

/** MVP cap on a hub's venue photos (ADR-028): a small storefront gallery, not
 *  an album. Enforced by the upload route. */
export const MAX_VENUE_PHOTOS = 6;

/** Weekday keys for a hub's opening hours (ADR-032), Monday-first to match
 *  ISO 8601 and the existing i18n catalogs (`hub.days.*`). */
export const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type DayKey = (typeof DAY_KEYS)[number];

/** Max open intervals per single day (ADR-032): one for a straight day, two
 *  for the common lunch-break split shift, a third as headroom — never a
 *  hard "exactly 2". */
export const MAX_OPENING_INTERVALS_PER_DAY = 3;
