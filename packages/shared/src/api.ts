// Zod schemas of the public REST API (ADR-002: OpenAPI is generated from
// these; the web app reuses them for form validation so client and server
// can never drift). Conventions:
//   - every msat amount travels as a DECIMAL STRING (JSON has no bigint,
//     ADR-008 forbids floats for money);
//   - timestamps are ISO 8601 UTC strings;
//   - the EUR exchange snapshot is expressed in SATS per EUR (matching the
//     `shipments.eur_rate_snapshot` column).

import { z } from 'zod';
// From the leaf module, NOT './index': the barrel re-exports this file, and
// a circular value import would leave these constants undefined while the
// schemas below are being built (silently disabling the checks).
import {
  CARRIER_TRIP_STATUSES,
  CODENAME_PATTERN,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  MAX_STORAGE_HOURS,
  PHOTO_KINDS,
  REVIEW_ROLES,
  SHIPMENT_STATES,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Scalars

/** Positive msat amount as a decimal string (fits a signed bigint column). */
export const msatString = z
  .string()
  .regex(/^\d{1,18}$/, 'msat amount as a decimal string')
  .describe('Amount in millisatoshi, as a decimal string');

export const uuidString = z.string().uuid();

/** A shipment codename ("Tasso-Ambrato-742"): the human-sayable label shown
 *  wherever a shipment is cited. A LABEL, never a credential (ARCHITECTURE.md
 *  §7) — the UUID and QR token are the real identifiers. */
export const codenameString = z
  .string()
  .regex(CODENAME_PATTERN, 'shipment codename Animal-Adjective-NNN')
  .describe('Human-sayable shipment label, e.g. "Tasso-Ambrato-742"');

/** SHA-256 of a photo the client took ON DEVICE (ADR-018 §6): the hash lands
 *  in the custody chain as the tamper-evident certification, and it is the
 *  content-addressed key of the optional blob upload (ADR-020). */
export const sha256String = z.string().regex(/^[0-9a-f]{64}$/, 'lowercase hex sha256');

export const photoHashesSchema = z.array(sha256String).min(1).max(10);

export const shipmentStateSchema = z.enum(SHIPMENT_STATES);

// ---------------------------------------------------------------------------
// Wallet connection (prerequisite for every money-bearing role — ADR-013)

export const connectWalletBody = z.object({
  kind: z.enum(['nwc', 'lnd_rest', 'fake']),
  /** NWC connection string, or a JSON `{ baseUrl, macaroonHex, allowInsecure? }`
   *  for lnd_rest, or an opaque wallet id for the fake (dev/test only).
   *  Stored encrypted at rest; never returned by any endpoint. */
  connectionSecret: z.string().min(1).max(10_000),
});

// ---------------------------------------------------------------------------
// Shipments

export const dimensionsSchema = z.object({
  lengthCm: z.number().int().positive().max(1000),
  widthCm: z.number().int().positive().max(1000),
  heightCm: z.number().int().positive().max(1000),
});

export const createShipmentBody = z.object({
  originHubId: uuidString,
  destHubId: uuidString,
  recipientEmail: z.string().email(),
  dims: dimensionsSchema,
  weightG: z.number().int().positive().max(50_000),
  declaredContent: z.string().min(1).max(500).optional(),
  undeclared: z.boolean().default(false),
  /** The sender's offer P — a spending commitment, paid leg by leg (ADR-013). */
  offerMsat: msatString,
  /** The single custody bond required from whoever holds the parcel (§6). */
  custodyBondMsat: msatString,
  /** Max storage per hub stay; capped by the CLTV budget (ESCROW.md §4). */
  maxStorageHours: z.number().int().min(1).max(MAX_STORAGE_HOURS),
  /** Optional sender photos at creation (ADR-022), certified by the
   *  `created` custody event. Distinct keys because one event certifies two
   *  photo kinds; both follow the ADR-020 §2 contract spelled out below. */
  contentPhotoSha256: photoHashesSchema
    .optional()
    .describe(
      'sha256 of the photos of the parcel CONTENT, hashed on the client. ' +
        'The client MUST strip EXIF (re-encode) BEFORE hashing: the later ' +
        'byte upload is refused if a GPS EXIF block is present (photo_exif_gps).',
    ),
  sealedPhotoSha256: photoHashesSchema
    .optional()
    .describe(
      'sha256 of the photos of the SEALED parcel, hashed on the client. ' +
        'Same contract as contentPhotoSha256: EXIF strip on device, before hashing.',
    ),
});

export const originCheckinBody = z.object({
  qrToken: z.string().min(1),
  photoSha256: photoHashesSchema,
});

export const legAcceptBody = z.object({
  /** The carrier's declared trip (MATCHING.md §1) — must be active. */
  tripId: uuidString,
  /** The drop hub H chosen from the board (H* or any alternative). */
  toHubId: uuidString,
});

export const checkoutConfirmBody = z.object({
  qrToken: z.string().min(1),
  /** Required with the HUB's confirmation (the hub certifies what it hands
   *  over, ARCHITECTURE.md §7); ignored on the carrier's confirmation. */
  photoSha256: photoHashesSchema.optional(),
});

export const legCheckinBody = z.object({
  qrToken: z.string().min(1),
  photoSha256: photoHashesSchema,
  /** Accept-or-reject, never judge (ADR-012): a hub that cannot certify
   *  integrity must call handoff-reject instead of sending `false`. */
  integrityConfirmed: z.literal(true),
});

export const legReturnBody = z.object({
  qrToken: z.string().min(1),
  photoSha256: photoHashesSchema,
});

export const recipientPickupBody = z.object({
  qrToken: z.string().min(1),
  /** The OTP the recipient received by email; typing it is the definitive
   *  acceptance (no contestation window — ARCHITECTURE.md §5 row 11). */
  otp: z.string().min(4).max(16),
});

/** ADR-016: the recipient claims the idle parcel with the bearer token from
 *  the tracking email. No QR needed — the parcel is not in their hands yet. */
export const recipientClaimBody = z.object({
  claimToken: z.string().min(1),
});

/** ADR-016: the physical pickup of a claimed parcel. The HUB drives this
 *  (its session), scanning the parcel QR and the claimant's token; accepting
 *  the handoff is definitive, exactly like the OTP pickup. */
export const claimedPickupBody = z.object({
  qrToken: z.string().min(1),
  claimToken: z.string().min(1),
});

export const boostBody = z.object({
  amountMsat: msatString,
  /** Client-generated key: a boost moves the sender's commitment, so a
   *  network retry must not double it (invariant 5). */
  idempotencyKey: z.string().min(8).max(64),
});

export const rerouteBody = z
  .object({
    newDestHubId: uuidString.optional(),
    newRecipientEmail: z.string().email().optional(),
  })
  .refine((body) => body.newDestHubId !== undefined || body.newRecipientEmail !== undefined, {
    message: 'reroute must change the destination hub and/or the recipient',
  });

export const handoffRejectBody = z.object({
  stage: z.enum(['pickup_checkout', 'hub_checkin', 'recipient_pickup']),
  reason: z.string().min(3).max(500),
  photoSha256: photoHashesSchema,
});

export const suggestedOfferQuery = z.object({
  originHubId: uuidString,
  destHubId: uuidString,
});

// ---------------------------------------------------------------------------
// Carrier trips and board

export const createTripBody = z.object({
  originLat: z.number().min(-90).max(90),
  originLng: z.number().min(-180).max(180),
  destLat: z.number().min(-90).max(90),
  destLng: z.number().min(-180).max(180),
  maxDeviationKm: z.number().positive().max(500),
  /** rate_min in msat per km of detour (MATCHING.md §1). */
  minRateMsatPerKm: msatString,
  departsAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
});

// ---------------------------------------------------------------------------
// Reviews (CLAUDE.md "Recensioni", ADR-017)

/** Body of POST /shipments/:id/reviews: one per-role judgment about one
 *  effective counterparty of a CLOSED shipment (ADR-017 defines who counts
 *  as effective in each role). */
export const createReviewBody = z.object({
  subjectId: uuidString,
  role: z.enum(REVIEW_ROLES),
  stars: z.number().int().min(1).max(5),
  comment: z.string().min(1).max(1000).optional(),
});

/** One per-role aggregate, always computed from the reviews table at read
 *  time — never denormalized (same principle as the ledger: no stale
 *  balances). `averageStars` is null until the first review. */
export const ratingDto = z.object({
  averageStars: z.number().nullable(),
  reviewCount: z.number().int(),
});

export const reviewDto = z.object({
  id: uuidString,
  shipmentId: uuidString,
  authorId: uuidString,
  subjectId: uuidString,
  role: z.enum(REVIEW_ROLES),
  stars: z.number().int(),
  comment: z.string().nullable(),
  createdAt: z.string(),
});

/** Response of GET /users/:id/reviews — the future profile page: per-role
 *  aggregates plus the received reviews, newest first. */
export const userReviewsDto = z.object({
  userId: uuidString,
  ratings: z.object({
    sender: ratingDto,
    carrier: ratingDto,
    hub: ratingDto,
  }),
  reviews: z.array(reviewDto),
});

/** Rating of one effective participant of a shipment (detail view): the
 *  hubId is set when the role is 'hub', so the UI can pin the rating to the
 *  hub card rather than to a bare user id. */
export const participantRatingDto = ratingDto.extend({
  userId: uuidString,
  role: z.enum(REVIEW_ROLES),
  hubId: uuidString.nullable(),
});

/** Query of GET /trips/:id/route (ADR-015): optionally previews one board
 *  shipment on top of the accepted legs — both fields or neither (the drop
 *  hub comes from the board card the carrier is looking at; the route
 *  enforces the pairing, zod refinements don't run on querystrings). */
export const tripRouteQuery = z.object({
  previewShipmentId: uuidString.optional(),
  previewDropHubId: uuidString.optional(),
});

// ---------------------------------------------------------------------------
// Account lists (ADR-018 §5): GET /me/shipments and GET /me/trips replace the
// device-local `localStorage` memory the web UI used to keep — the account
// is now the source of a user's own shipments and declared trips.

export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

export const meShipmentDto = z.object({
  id: uuidString,
  codename: codenameString,
  status: shipmentStateSchema,
  originHubId: uuidString,
  originHubName: z.string(),
  destHubId: uuidString,
  destHubName: z.string(),
  offerMsat: msatString,
  createdAt: z.string(),
});

export const meShipmentsDto = z.object({
  items: z.array(meShipmentDto),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

/** One declared trip (MATCHING.md §1). `status` mirrors the DB column, which
 *  a transition never rewrites (see CARRIER_TRIP_STATUSES): callers treat a
 *  trip as active iff `status === 'active' && expiresAt` is in the future. */
export const meTripDto = z.object({
  id: uuidString,
  status: z.enum(CARRIER_TRIP_STATUSES),
  originLat: z.number(),
  originLng: z.number(),
  destLat: z.number(),
  destLng: z.number(),
  maxDeviationKm: z.number(),
  minRateMsatPerKm: msatString,
  departsAt: z.string(),
  expiresAt: z.string(),
  createdAt: z.string(),
});

export const meTripsDto = z.object({
  items: z.array(meTripDto),
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

// ---------------------------------------------------------------------------
// Response DTOs (zod so fastify serializes them — a bigint can never leak)

export const eurRateDto = z.object({
  satsPerEur: z.string(),
  source: z.string(),
  at: z.string(),
});

export const legDto = z.object({
  id: uuidString,
  seq: z.number().int(),
  status: z.enum([
    'pending_funding',
    'booked',
    'picked_up',
    'completed',
    'returned',
    'expired',
    'failed',
  ]),
  carrierId: uuidString,
  fromHubId: uuidString,
  toHubId: uuidString,
  progressKm: z.number(),
  grossMsat: msatString,
  depHubFeeMsat: msatString,
  arrHubFeeMsat: msatString,
  netMsat: msatString,
  finalizationBonusMsat: msatString,
  fundingDeadlineAt: z.string().nullable(),
  pickupDeadlineAt: z.string().nullable(),
  transitDeadlineAt: z.string().nullable(),
});

export const custodyEventDto = z.object({
  type: z.string(),
  actorUserId: uuidString.nullable(),
  legId: uuidString.nullable(),
  hubStayId: uuidString.nullable(),
  /** Canonical payload — msat amounts appear as decimal strings, no PII. */
  payload: z.record(z.unknown()),
  hash: z.string(),
  createdAt: z.string(),
});

export const shipmentDetailDto = z.object({
  id: uuidString,
  codename: codenameString,
  status: shipmentStateSchema,
  senderId: uuidString,
  originHubId: uuidString,
  destHubId: uuidString,
  currentHubId: uuidString.nullable(),
  /** Only present for the sender (it authorizes nothing by itself, but it
   *  is the parcel's identifier and gets printed once). */
  qrToken: z.string().optional(),
  recipientEmail: z.string().optional(),
  dims: dimensionsSchema,
  weightG: z.number().int(),
  declaredContent: z.string().nullable(),
  undeclared: z.boolean(),
  offerMsat: msatString,
  segmentWorkMsat: msatString,
  /** Remaining work pool at the current position (notional — ADR-013). */
  remainingPoolMsat: msatString,
  custodyBondMsat: msatString,
  maxStorageHours: z.number().int(),
  distanceKm: z.number(),
  remainingKm: z.number().nullable(),
  eurRate: eurRateDto,
  createdAt: z.string(),
  legs: z.array(legDto),
  custodyChain: z.array(custodyEventDto),
  /** Per-role ratings of every effective participant (ADR-017): the sender,
   *  the carriers of funded legs, the hubs that hosted the parcel, a funded
   *  claimant. Computed from the reviews table on read. */
  ratings: z.array(participantRatingDto),
});

/** One uploaded photo of a shipment (ADR-020): metadata only — the bytes are
 *  served by GET /shipments/:id/photos/:sha256 with the same session authz.
 *  `custodyEventId` is null only for a checkout photo uploaded while the
 *  double confirmation is still pending. */
export const shipmentPhotoDto = z.object({
  sha256: sha256String,
  kind: z.enum(PHOTO_KINDS),
  custodyEventId: uuidString.nullable(),
  takenBy: uuidString,
  createdAt: z.string(),
});

export const shipmentPhotosDto = z.object({
  photos: z.array(shipmentPhotoDto),
});

/** Response of POST /shipments/:id/photos/:sha256 (ADR-020): `duplicated` is
 *  true when the same hash was already uploaded for this shipment (the
 *  content-addressed store makes the retry a no-op). */
export const photoUploadedDto = z.object({
  sha256: sha256String,
  kind: z.enum(PHOTO_KINDS),
  duplicated: z.boolean(),
});

/** Response of POST /shipments/:id/claim (ADR-016): the frozen claim amounts
 *  and the funding window the sender's wallet must honor. */
export const claimCreatedDto = z.object({
  claimId: uuidString,
  status: z.literal('pending_funding'),
  claimPaymentMsat: msatString,
  hubBonusMsat: msatString,
  fundingDeadlineAt: z.string(),
});

export const shipmentCreatedDto = z.object({
  id: uuidString,
  codename: codenameString,
  status: shipmentStateSchema,
  qrToken: z.string(),
  distanceKm: z.number(),
  segmentWorkMsat: msatString,
  eurRate: eurRateDto,
  /** True when the origin hub auto-accepted (its bond is already held). */
  originAccepted: z.boolean(),
});

/** Public status by QR scan: whoever frames the parcel sees at most this
 *  (ARCHITECTURE.md §7 — no action is possible with the QR alone). */
export const shipmentPublicDto = z.object({
  codename: codenameString,
  status: shipmentStateSchema,
  originHubName: z.string(),
  destHubName: z.string(),
});

export const dropHubOptionDto = z.object({
  hubId: uuidString,
  hubName: z.string(),
  detourKm: z.number(),
  netMsat: msatString,
  /** The "premio consegna" line, shown separately on the card (ADR-014). */
  finalizationBonusMsat: msatString,
  surplusMsat: msatString,
  /** Hub-role rating of the hub's owner (CLAUDE.md: visible wherever a
   *  counterparty is chosen), computed from the reviews table on read. */
  hubRating: ratingDto,
});

export const boardCardDto = z.object({
  shipmentId: uuidString,
  codename: codenameString,
  isMatch: z.boolean(),
  bestDropHub: dropHubOptionDto,
  alternatives: z.array(dropHubOptionDto),
  currentHubId: uuidString,
  currentHubName: z.string(),
  destHubId: uuidString,
  remainingKm: z.number(),
  totalKm: z.number(),
  custodyBondMsat: msatString,
  dims: dimensionsSchema,
  weightG: z.number().int(),
  undeclared: z.boolean(),
  /** MATCHING.md §3: the card shows the sender's rating and the ratings of
   *  the hubs involved (the drop options carry their own `hubRating`). */
  senderRating: ratingDto,
  currentHubRating: ratingDto,
  /** The shipment's FROZEN exchange snapshot (ADR-008): the indicative € on
   *  the card must use the rate that will govern the carrier's payout. */
  eurRate: eurRateDto,
});

/** Response of GET /shipments/suggested-offer (MATCHING.md §5). The msat
 *  equivalent is computed server-side at the current snapshot: the client
 *  prefills a sats-first input and never converts money itself (ADR-008). */
export const suggestedOfferDto = z.object({
  routeKm: z.number(),
  suggestedEur: z.number(),
  suggestedMsat: msatString,
  eurRate: eurRateDto,
});

/** Response of GET /trips/suggested-rate (MATCHING.md §4) — same contract:
 *  EUR for display, msat (per km of detour) for the input prefill. */
export const suggestedRateDto = z.object({
  eurPerKm: z.number(),
  msatPerKm: msatString,
  eurRate: eurRateDto,
});

/** One stop of the trip route view (ADR-015): a RouteStop plus what the UI
 *  needs to draw and link it. `legId` is null for board previews. */
export const routeStopDto = z.object({
  hubId: uuidString,
  hubName: z.string(),
  lat: z.number(),
  lng: z.number(),
  kind: z.enum(['pickup', 'drop']),
  shipmentId: uuidString,
  legId: uuidString.nullable(),
  preview: z.boolean(),
});

/** Response of GET /trips/:id/route (ADR-015, data part): the stops in the
 *  computed visit order plus the Google Maps deep link. Stops beyond
 *  MAX_ROUTE_WAYPOINTS come back in `unroutedStops` for the UI to list. */
export const tripRouteDto = z.object({
  tripId: uuidString,
  origin: z.object({ lat: z.number(), lng: z.number() }),
  destination: z.object({ lat: z.number(), lng: z.number() }),
  stops: z.array(routeStopDto),
  unroutedStops: z.array(routeStopDto),
  googleMapsUrl: z.string(),
});

export const hubDto = z.object({
  id: uuidString,
  name: z.string(),
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  feePercent: z.string(),
  maxDims: dimensionsSchema,
  maxWeightG: z.number().int(),
  acceptsUndeclared: z.boolean(),
  maxStorageHours: z.number().int(),
  autoAccept: z.boolean(),
  walletConnected: z.boolean(),
  /** Hub-role rating of the owner — the sender picks hubs here. */
  rating: ratingDto,
});

export type CreateShipmentBody = z.infer<typeof createShipmentBody>;
export type LegAcceptBody = z.infer<typeof legAcceptBody>;
export type CreateTripBody = z.infer<typeof createTripBody>;
export type ShipmentDetailDto = z.infer<typeof shipmentDetailDto>;
export type BoardCardDto = z.infer<typeof boardCardDto>;
export type ListQuery = z.infer<typeof listQuery>;
export type MeShipmentDto = z.infer<typeof meShipmentDto>;
export type MeShipmentsDto = z.infer<typeof meShipmentsDto>;
export type MeTripDto = z.infer<typeof meTripDto>;
export type MeTripsDto = z.infer<typeof meTripsDto>;
export type ShipmentPhotoDto = z.infer<typeof shipmentPhotoDto>;
export type ShipmentPhotosDto = z.infer<typeof shipmentPhotosDto>;
