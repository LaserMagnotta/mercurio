// Typed bindings for the API routes the web UI consumes. Response/request
// shapes come from the SHARED Zod schemas (`@mercurio/shared`, ADR-002):
// client and server cannot drift. Endpoints without a shared DTO (auth, me,
// wallet — plain object responses in the routes) are typed here explicitly.

import type { z } from 'zod';
import type {
  boardCardDto,
  claimCreatedDto,
  createReviewBody,
  createShipmentBody,
  createTripBody,
  handoffRejectBody,
  hubDto,
  meShipmentsDto,
  meTripsDto,
  photoUploadedDto,
  shipmentCreatedDto,
  shipmentDetailDto,
  shipmentPhotoDto,
  shipmentPhotosDto,
  shipmentPublicDto,
  suggestedOfferDto,
  suggestedRateDto,
  tripRouteDto,
  userReviewsDto,
} from '@mercurio/shared';
import type { CapturedPhoto } from '../photo-capture';
import { apiFetch, apiUploadJpeg } from './client';

export type Hub = z.infer<typeof hubDto>;
export type MeShipments = z.infer<typeof meShipmentsDto>;
export type MeTrips = z.infer<typeof meTripsDto>;
export type ShipmentDetail = z.infer<typeof shipmentDetailDto>;
export type ShipmentCreated = z.infer<typeof shipmentCreatedDto>;
export type ShipmentPublic = z.infer<typeof shipmentPublicDto>;
export type BoardCard = z.infer<typeof boardCardDto>;
export type TripRoute = z.infer<typeof tripRouteDto>;
export type SuggestedOffer = z.infer<typeof suggestedOfferDto>;
export type SuggestedRate = z.infer<typeof suggestedRateDto>;
export type CreateShipmentInput = z.infer<typeof createShipmentBody>;
export type CreateTripInput = z.infer<typeof createTripBody>;
export type ClaimCreated = z.infer<typeof claimCreatedDto>;
export type CreateReviewInput = z.infer<typeof createReviewBody>;
export type UserReviews = z.infer<typeof userReviewsDto>;
export type HandoffRejectInput = z.infer<typeof handoffRejectBody>;
export type ShipmentPhoto = z.infer<typeof shipmentPhotoDto>;
export type ShipmentPhotos = z.infer<typeof shipmentPhotosDto>;
export type PhotoUploaded = z.infer<typeof photoUploadedDto>;

// --------------------------------------------------------------------- auth

export interface SessionUser {
  id: string;
  email: string;
}

export interface Me extends SessionUser {
  locale: string;
  createdAt: string;
  roles: { carrier: boolean; hub: boolean };
}

export interface ConsentInput {
  tosVersion: string;
  privacyVersion: string;
}

export const requestLoginLink = (email: string) =>
  apiFetch<{ ok: true }>('/auth/request-link', { method: 'POST', body: { email } });

export const verifyMagicLink = (token: string, consent?: ConsentInput) =>
  apiFetch<{ user: SessionUser }>('/auth/verify', {
    method: 'POST',
    body: consent ? { token, consent } : { token },
  });

export const logout = () => apiFetch<{ ok: true }>('/auth/logout', { method: 'POST' });

export const getMe = () => apiFetch<Me>('/me');

export const activateCarrierRole = () =>
  apiFetch<{ ok: true }>('/me/roles/carrier', { method: 'POST' });

/** Body of POST /me/roles/hub — declared in the API route (no shared DTO):
 *  the hub's public constraints (CLAUDE.md "Hub — dettagli"). */
export interface RegisterHubInput {
  name: string;
  address: string;
  /** Optional venue contact address, distinct from the account email (ADR-028):
   *  deposit-request notifications go here when set. */
  contactEmail?: string;
  lat: number;
  lng: number;
  openingHours: Record<string, string>;
  maxDimCmL: number;
  maxDimCmW: number;
  maxDimCmH: number;
  maxWeightG: number;
  acceptsUndeclared: boolean;
  feePercent: number;
  maxStorageDays: number;
  autoAccept: boolean;
}

export const registerHubRole = (body: RegisterHubInput) =>
  apiFetch<{ id: string }>('/me/roles/hub', { method: 'POST', body });

export const exportMyData = () => apiFetch<Record<string, unknown>>('/me/export');

export const deleteMyAccount = () => apiFetch<{ ok: true }>('/me', { method: 'DELETE' });

/** ADR-018 §5: the account is the source of a user's own shipments/trips —
 *  simple offset pagination, newest declaration first. */
export const getMyShipments = (params?: { limit?: number; offset?: number }) =>
  apiFetch<MeShipments>('/me/shipments', { query: { ...params } });

export const getMyTrips = (params?: { limit?: number; offset?: number }) =>
  apiFetch<MeTrips>('/me/trips', { query: { ...params } });

// ------------------------------------------------------------------- wallet

export type WalletKind = 'nwc' | 'lnd_rest' | 'fake';

export interface WalletConnection {
  id: string;
  kind: WalletKind;
  status: string;
  createdAt: string;
}

export const getWallet = () => apiFetch<{ wallet: WalletConnection | null }>('/me/wallet');

export const connectWallet = (kind: WalletKind, connectionSecret: string) =>
  apiFetch<{ id: string; kind: WalletKind; status: string }>('/me/wallet', {
    method: 'POST',
    body: { kind, connectionSecret },
  });

// --------------------------------------------------------------------- hubs

export interface HubSearchParams {
  /** Viewport filter "minLat,minLng,maxLat,maxLng". */
  bbox?: string;
  /** Case-insensitive substring on name and address. */
  q?: string;
  /** "lat,lng": sort by distance from here; fills each hub's distanceKm. */
  near?: string;
  limit?: number;
  offset?: number;
}

/** Paginated hub discovery (ADR-030): the page plus the pre-pagination total. */
export const searchHubs = (params: HubSearchParams) =>
  apiFetch<{ hubs: Hub[]; total: number }>('/hubs', { query: { ...params } });

export const getHub = (id: string) => apiFetch<Hub>(`/hubs/${id}`);

/** One shipment waiting for a carrier at a hub (ADR-030 reverse trip
 *  planning): indicative gross ceiling, never a frozen per-leg price. */
export interface HubWaitingShipment {
  shipmentId: string;
  codename: string;
  destHubId: string;
  destHubName: string;
  remainingKm: number;
  dims: { lengthCm: number; widthCm: number; heightCm: number };
  weightG: number;
  undeclared: boolean;
  custodyBondMsat: string;
  maxGrossMsat: string;
  eurRate: EurRate;
}

export const getHubWaitingShipments = (hubId: string) =>
  apiFetch<{ hubId: string; shipments: HubWaitingShipment[] }>(
    `/hubs/${hubId}/waiting-shipments`,
  );

// Response of GET /hubs/mine/requests (the hub owner's dashboard) — shaped
// in the API route, typed here explicitly like the other non-DTO endpoints.

/** The shipment's frozen exchange snapshot (ADR-008): sats-first amounts carry
 *  the rate that governs them so every one shows "≈ €" (matches eurRateDto). */
export interface EurRate {
  satsPerEur: string;
  source: string;
  at: string;
}

/** What the hub earns from a dashboard row (Fase 2 punto 7): an exact figure
 *  where an adjacent leg is priced, a "from–to" range where the leg split is
 *  not known yet. Both in msat, rendered sats-first + indicative € via Amount. */
export type ProjectedEarning =
  | { kind: 'exact'; msat: string }
  | { kind: 'range'; minMsat: string; maxMsat: string };

export interface HubAcceptRequest {
  shipmentId: string;
  codename: string;
  destHubId: string;
  dims: { lengthCm: number; widthCm: number; heightCm: number };
  weightG: number;
  undeclared: boolean;
  custodyBondMsat: string;
  maxStorageDays: number;
  projectedEarning: ProjectedEarning;
  eurRate: EurRate;
  createdAt: string;
}

export interface HubStaySummary {
  hubStayId: string;
  shipmentId: string;
  codename: string;
  status: 'reserved' | 'active';
  /** Lowercase DB enum (e.g. "at_hub") — uppercase it for ShipmentState. */
  shipmentStatus: string;
  storageDeadlineAt: string | null;
  custodyBondMsat: string;
  projectedEarning: ProjectedEarning;
  eurRate: EurRate;
  destHubId: string;
}

/** An arrival deposit request (ADR-029): a carrier asked to drop a parcel at
 *  this hub; the leg sits in 'requested' until the hub answers, and the
 *  earning is EXACT (the leg's arrival fee was frozen at the request). */
export interface HubDepositRequest {
  shipmentId: string;
  legId: string;
  codename: string;
  fromHubId: string;
  destHubId: string;
  dims: { lengthCm: number; widthCm: number; heightCm: number };
  weightG: number;
  undeclared: boolean;
  custodyBondMsat: string;
  maxStorageDays: number;
  responseDeadlineAt: string | null;
  projectedEarning: ProjectedEarning;
  eurRate: EurRate;
  requestedAt: string;
}

export interface HubDashboard {
  hubId: string;
  /** ADR-029 / punto 9: pinned on top, soonest response deadline first. */
  depositRequests: HubDepositRequest[];
  acceptRequests: HubAcceptRequest[];
  stays: HubStaySummary[];
}

export const getMyHubRequests = () => apiFetch<HubDashboard>('/hubs/mine/requests');

// --------------------------------------------------------- venue photos (ADR-028)

export interface VenuePhoto {
  sha256: string;
  createdAt: string;
}

/** Public list of a hub's venue photos (bytes come from venuePhotoUrl). */
export const getVenuePhotos = (hubId: string) =>
  apiFetch<{ photos: VenuePhoto[] }>(`/hubs/${hubId}/venue-photos`);

/** Same-origin URL of one venue photo's bytes (usable in <img src>). Public —
 *  no session needed (ADR-028), unlike shipment photos. */
export const venuePhotoUrl = (hubId: string, sha256: string) =>
  `/api/hubs/${hubId}/venue-photos/${sha256}`;

/** Owner-only: upload a re-encoded, EXIF-stripped venue photo (ADR-028). */
export const uploadVenuePhoto = (photo: CapturedPhoto) =>
  apiUploadJpeg<{ sha256: string; duplicated: boolean }>(
    `/hubs/mine/venue-photos/${photo.sha256}`,
    photo.blob,
  );

export const deleteVenuePhoto = (sha256: string) =>
  apiFetch<{ deleted: true }>(`/hubs/mine/venue-photos/${sha256}`, { method: 'DELETE' });

// ---------------------------------------------------------------- shipments

export const getSuggestedOffer = (originHubId: string, destHubId: string) =>
  apiFetch<SuggestedOffer>('/shipments/suggested-offer', {
    query: { originHubId, destHubId },
  });

export const createShipment = (body: CreateShipmentInput) =>
  apiFetch<ShipmentCreated>('/shipments', { method: 'POST', body });

export const getShipment = (id: string) => apiFetch<ShipmentDetail>(`/shipments/${id}`);

export const boostShipment = (id: string, amountMsat: string, idempotencyKey: string) =>
  apiFetch<{ status: string; deduplicated: boolean }>(`/shipments/${id}/boost`, {
    method: 'POST',
    body: { amountMsat, idempotencyKey },
  });

export const rerouteShipment = (
  id: string,
  body: { newDestHubId?: string; newRecipientEmail?: string },
) => apiFetch<{ status: string }>(`/shipments/${id}/reroute`, { method: 'POST', body });

export const cancelShipment = (id: string) =>
  apiFetch<{ status: string }>(`/shipments/${id}/cancel`, { method: 'POST' });

// ------------------------------------------- lifecycle handoffs (part 2)
// Every action is QR + authenticated session (ARCHITECTURE.md §7); photos
// travel as client-declared sha256 hashes (lib/photo-hash.ts). The API is
// the judge of every guard — these bindings only carry the facts.

export const originAccept = (id: string) =>
  apiFetch<{ status: string }>(`/shipments/${id}/origin-accept`, { method: 'POST' });

export const originCheckin = (id: string, qrToken: string, photoSha256: string[]) =>
  apiFetch<{ status: string }>(`/shipments/${id}/origin-checkin`, {
    method: 'POST',
    body: { qrToken, photoSha256 },
  });

export interface CheckoutConfirmation {
  confirmed: 'hub' | 'carrier';
  complete: boolean;
  status: string;
}

/** Double-confirmation checkout: the hub confirms with photos, the carrier
 *  without; the parcel changes custody when BOTH land in the window. */
export const confirmCheckout = (id: string, qrToken: string, photoSha256?: string[]) =>
  apiFetch<CheckoutConfirmation>(`/shipments/${id}/pickup-checkout`, {
    method: 'POST',
    body: { qrToken, ...(photoSha256 && { photoSha256 }) },
  });

export const legCheckin = (id: string, qrToken: string, photoSha256: string[]) =>
  apiFetch<{ status: string }>(`/shipments/${id}/checkin`, {
    method: 'POST',
    // integrityConfirmed is literal true by schema: a hub that cannot certify
    // integrity must file a handoff-reject instead (ADR-012).
    body: { qrToken, photoSha256, integrityConfirmed: true },
  });

export const legReturn = (id: string, qrToken: string, photoSha256: string[]) =>
  apiFetch<{ status: string }>(`/shipments/${id}/return`, {
    method: 'POST',
    body: { qrToken, photoSha256 },
  });

export const recipientPickup = (id: string, qrToken: string, otp: string) =>
  apiFetch<{ status: string }>(`/shipments/${id}/pickup`, {
    method: 'POST',
    body: { qrToken, otp },
  });

export const recipientClaim = (id: string, claimToken: string) =>
  apiFetch<ClaimCreated>(`/shipments/${id}/claim`, {
    method: 'POST',
    body: { claimToken },
  });

export const claimedPickup = (id: string, qrToken: string, claimToken: string) =>
  apiFetch<{ status: string }>(`/shipments/${id}/claimed-pickup`, {
    method: 'POST',
    body: { qrToken, claimToken },
  });

export const rejectHandoff = (id: string, body: HandoffRejectInput) =>
  apiFetch<{ status: string }>(`/shipments/${id}/reject`, { method: 'POST', body });

// ------------------------------------------------------------------- photos
// ADR-020: hashes certify (custody chain), blobs document. The upload sends
// the EXACT bytes the hash was computed on; the API verifies and refuses
// anything else. Download URLs point at the same-origin proxy so the session
// cookie authorizes every request — no public URLs exist.

export const uploadShipmentPhoto = (shipmentId: string, photo: CapturedPhoto) =>
  apiUploadJpeg<PhotoUploaded>(`/shipments/${shipmentId}/photos/${photo.sha256}`, photo.blob);

/** Best-effort upload of every certified photo AFTER the transition landed
 *  (ADR-020 §3: certification first, bytes second). Returns how many failed —
 *  a failure never voids the certification, the UI just says so. */
export async function uploadShipmentPhotos(
  shipmentId: string,
  photos: CapturedPhoto[],
): Promise<number> {
  let failed = 0;
  for (const photo of photos) {
    try {
      await uploadShipmentPhoto(shipmentId, photo);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

export const getShipmentPhotos = (shipmentId: string) =>
  apiFetch<ShipmentPhotos>(`/shipments/${shipmentId}/photos`);

/** Same-origin URL of one photo's bytes (usable in <img src>). */
export const shipmentPhotoUrl = (shipmentId: string, sha256: string) =>
  `/api/shipments/${shipmentId}/photos/${sha256}`;

// ------------------------------------------------------------------ reviews

export const createReview = (shipmentId: string, body: CreateReviewInput) =>
  apiFetch<{ id: string }>(`/shipments/${shipmentId}/reviews`, { method: 'POST', body });

/** Public profile data; `baseUrl` for server-side rendering (ADR-018). */
export const getUserReviews = (userId: string, baseUrl?: string) =>
  apiFetch<UserReviews>(`/users/${userId}/reviews`, baseUrl ? { baseUrl } : {});

// -------------------------------------------------------------------- trips

export const createTrip = (body: CreateTripInput) =>
  apiFetch<{
    id: string;
    maxDeviationKm: number;
    minRateMsatPerKm: string;
    departsAt: string;
    expiresAt: string;
  }>('/trips', { method: 'POST', body });

export const getSuggestedRate = () => apiFetch<SuggestedRate>('/trips/suggested-rate');

export const getBoard = (tripId: string) =>
  apiFetch<{ tripId: string; cards: BoardCard[] }>(`/trips/${tripId}/board`);

export const getTripRoute = (
  tripId: string,
  preview?: { previewShipmentId: string; previewDropHubId: string },
) => apiFetch<TripRoute>(`/trips/${tripId}/route`, { query: { ...preview } });

export interface LegPricing {
  grossMsat: string;
  depHubFeeMsat: string;
  arrHubFeeMsat: string;
  netMsat: string;
  finalizationBonusMsat: string;
}

/** ADR-029: opening a leg toward an auto-accept hub books it instantly
 *  ('pending_funding'); toward a manual hub it opens a deposit REQUEST
 *  ('requested') the hub must answer within responseDeadlineAt. */
export const acceptLeg = (shipmentId: string, tripId: string, toHubId: string) =>
  apiFetch<{
    legId: string;
    status: 'pending_funding' | 'requested';
    responseDeadlineAt: string;
    fundingDeadlineAt: string | null;
    requiresHubConfirmation: boolean;
    pricing: LegPricing;
  }>(`/shipments/${shipmentId}/legs`, { method: 'POST', body: { tripId, toHubId } });

// ----------------------------------------- deposit-request answers (ADR-029)

/** Arrival hub: accept the pending deposit request — creates the holds and
 *  opens the funding window (the money moves only from here on). */
export const depositAccept = (shipmentId: string, legId: string) =>
  apiFetch<{ status: string; fundingDeadlineAt: string }>(
    `/shipments/${shipmentId}/legs/${legId}/deposit-accept`,
    { method: 'POST' },
  );

/** Arrival hub: refuse the request (documentation, ADR-012 — a reason is
 *  required). Zero money moves; the shipment returns to the board. */
export const depositReject = (shipmentId: string, legId: string, reason: string) =>
  apiFetch<{ status: string }>(`/shipments/${shipmentId}/legs/${legId}/deposit-reject`, {
    method: 'POST',
    body: { reason },
  });

/** Carrier: withdraw the pending request to re-target another hub. */
export const depositCancel = (shipmentId: string, legId: string) =>
  apiFetch<{ status: string }>(`/shipments/${shipmentId}/legs/${legId}/deposit-cancel`, {
    method: 'POST',
  });
