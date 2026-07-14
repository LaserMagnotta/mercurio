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
  shipmentCreatedDto,
  shipmentDetailDto,
  shipmentPublicDto,
  suggestedOfferDto,
  suggestedRateDto,
  tripRouteDto,
  userReviewsDto,
} from '@mercurio/shared';
import { apiFetch } from './client';

export type Hub = z.infer<typeof hubDto>;
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
  lat: number;
  lng: number;
  openingHours: Record<string, string>;
  maxDimCmL: number;
  maxDimCmW: number;
  maxDimCmH: number;
  maxWeightG: number;
  acceptsUndeclared: boolean;
  feePercent: number;
  maxStorageHours: number;
  autoAccept: boolean;
}

export const registerHubRole = (body: RegisterHubInput) =>
  apiFetch<{ id: string }>('/me/roles/hub', { method: 'POST', body });

export const exportMyData = () => apiFetch<Record<string, unknown>>('/me/export');

export const deleteMyAccount = () => apiFetch<{ ok: true }>('/me', { method: 'DELETE' });

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

export const getHubs = () => apiFetch<{ hubs: Hub[] }>('/hubs');

// Response of GET /hubs/mine/requests (the hub owner's dashboard) — shaped
// in the API route, typed here explicitly like the other non-DTO endpoints.

export interface HubAcceptRequest {
  shipmentId: string;
  destHubId: string;
  dims: { lengthCm: number; widthCm: number; heightCm: number };
  weightG: number;
  undeclared: boolean;
  custodyBondMsat: string;
  maxStorageHours: number;
  createdAt: string;
}

export interface HubStaySummary {
  hubStayId: string;
  shipmentId: string;
  status: 'reserved' | 'active';
  /** Lowercase DB enum (e.g. "at_hub") — uppercase it for ShipmentState. */
  shipmentStatus: string;
  storageDeadlineAt: string | null;
  custodyBondMsat: string;
}

export interface HubDashboard {
  hubId: string;
  acceptRequests: HubAcceptRequest[];
  stays: HubStaySummary[];
}

export const getMyHubRequests = () => apiFetch<HubDashboard>('/hubs/mine/requests');

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

export const acceptLeg = (shipmentId: string, tripId: string, toHubId: string) =>
  apiFetch<{ legId: string; fundingDeadlineAt: string; pricing: LegPricing }>(
    `/shipments/${shipmentId}/legs`,
    { method: 'POST', body: { tripId, toHubId } },
  );
