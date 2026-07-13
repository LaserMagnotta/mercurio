// Zod schemas of the public REST API (ADR-002: OpenAPI is generated from
// these; the web app reuses them for form validation so client and server
// can never drift). Conventions:
//   - every msat amount travels as a DECIMAL STRING (JSON has no bigint,
//     ADR-008 forbids floats for money);
//   - timestamps are ISO 8601 UTC strings;
//   - the EUR exchange snapshot is expressed in SATS per EUR (matching the
//     `shipments.eur_rate_snapshot` column).

import { z } from 'zod';
import { MAX_STORAGE_HOURS, SHIPMENT_STATES } from './index';

// ---------------------------------------------------------------------------
// Scalars

/** Positive msat amount as a decimal string (fits a signed bigint column). */
export const msatString = z
  .string()
  .regex(/^\d{1,18}$/, 'msat amount as a decimal string')
  .describe('Amount in millisatoshi, as a decimal string');

export const uuidString = z.string().uuid();

/** SHA-256 of a photo the client took; the API stores hashes, not blobs
 *  (blob storage is out of the MVP API — the hash lands in the custody
 *  chain as the tamper-evident certification). */
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
// Response DTOs (zod so fastify serializes them — a bigint can never leak)

export const eurRateDto = z.object({
  satsPerEur: z.string(),
  source: z.string(),
  at: z.string(),
});

export const legDto = z.object({
  id: uuidString,
  seq: z.number().int(),
  status: z.enum(['pending_funding', 'booked', 'picked_up', 'completed', 'returned', 'expired', 'failed']),
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
});

export const boardCardDto = z.object({
  shipmentId: uuidString,
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
});

export type CreateShipmentBody = z.infer<typeof createShipmentBody>;
export type LegAcceptBody = z.infer<typeof legAcceptBody>;
export type CreateTripBody = z.infer<typeof createTripBody>;
export type ShipmentDetailDto = z.infer<typeof shipmentDetailDto>;
export type BoardCardDto = z.infer<typeof boardCardDto>;
