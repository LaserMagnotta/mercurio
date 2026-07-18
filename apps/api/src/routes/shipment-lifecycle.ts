// Lifecycle transition endpoints (ARCHITECTURE.md §5).
//
// Authorization lives HERE, outside the machine (precisazione 10): sessions,
// QR possession, OTP hash verification, "who may say what". The machine then
// validates protocol guards on the FACTS these routes declare (otpVerified,
// photo hashes, double confirmation) and decides every amount; the routes
// never compute money beyond calling the pure pricing engine for leg_accept
// inputs.
//
// One Lightning-imposed rule shows up in several guards: a hold invoice
// needs payer ≠ payee, so the roles of one shipment must be disjoint users
// (sender ≠ hub owners ≠ carrier of a leg). The checks return
// `self_payment_impossible` before the wallets ever get asked.

import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import { carrierTrips, custodyEvents, emailOutbox, hubs, legs, rejections, users } from '@mercurio/db';
import { EconomicsError, applyReroute, floorToSat, priceClaim, priceLeg, splitCommitment } from '@mercurio/core';
import {
  boostBody,
  checkoutConfirmBody,
  CHECKOUT_CONFIRMATION_WINDOW_MINUTES,
  claimedPickupBody,
  DEPOSIT_RESPONSE_WINDOW_MINUTES,
  depositRejectBody,
  handoffRejectBody,
  hubFeePercentToBp,
  legAcceptBody,
  legCheckinBody,
  legReturnBody,
  LEG_FUNDING_WINDOW_MINUTES,
  originCheckinBody,
  recipientClaimBody,
  recipientPickupBody,
  rerouteBody,
  TRANSIT_WINDOW_HOURS,
} from '@mercurio/shared';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { hashToken } from '../lib/tokens.js';
import { hasConnectedWallet } from '../lib/wallets.js';
import { parcelFitsHub, storageFitsHub } from '../lib/parcel.js';
import { msat } from '../lib/serialize.js';
import {
  loadShipmentBundle,
  remainingWorkPool,
  type HubRow,
  type ShipmentBundle,
} from '../shipments/context.js';
import { executeShipmentTransition } from '../shipments/executor.js';
import { ConflictError } from '../shipments/errors.js';
import { replyLifecycleError } from './lifecycle-errors.js';

const params = z.object({ id: z.string().uuid() });

const hoursFromNow = (now: Date, hours: number) =>
  new Date(now.getTime() + hours * 60 * 60 * 1000);
// Storage is chosen in DAYS (ADR-026) but the timer is armed at an absolute
// instant, and the 72/24 h warnings still count in hours — so a stay's window
// is just days × 24 h.
const daysFromNow = (now: Date, days: number) => hoursFromNow(now, days * 24);
const minutesFromNow = (now: Date, minutes: number) =>
  new Date(now.getTime() + minutes * 60 * 1000);

export function registerShipmentLifecycleRoutes(app: App) {
  const deps = () => app.lifecycle;

  async function loadOr404(id: string, reply: FastifyReply): Promise<ShipmentBundle | null> {
    const bundle = await loadShipmentBundle(app.db, id);
    if (!bundle) {
      await reply.code(404).send({ error: 'not_found' });
      return null;
    }
    return bundle;
  }

  function qrMatches(bundle: ShipmentBundle, qrToken: string): boolean {
    return bundle.shipment.qrToken === qrToken;
  }

  function currentHubOf(bundle: ShipmentBundle): HubRow | null {
    const stay = bundle.currentStayRow;
    return stay ? (bundle.hubById.get(stay.hubId) ?? null) : null;
  }

  // ------------------------------------------------------------- row 2
  // Manual acceptance by the origin hub (auto_accept hubs run this at
  // creation, see routes/shipments.ts).
  app.post(
    '/shipments/:id/origin-accept',
    { schema: { params }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const originHub = bundle.hubById.get(bundle.shipment.originHubId);
      if (!originHub || originHub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_origin_hub' });
      }
      const s = bundle.shipment;
      const problem =
        parcelFitsHub(s, originHub) ?? storageFitsHub(s.maxStorageDays, originHub);
      if (problem) return reply.code(422).send({ error: problem });
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: s.id,
          event: {
            type: 'origin_hub_accept',
            hubStayId: randomUUID(),
            hubWalletConnected: await hasConnectedWallet(app.db, request.userId!),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'AWAITING_DROPOFF' };
    },
  );

  // ------------------------------------------------------------- row 3
  app.post(
    '/shipments/:id/origin-checkin',
    { schema: { params, body: originCheckinBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const hub = currentHubOf(bundle);
      if (!hub || hub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_custodian_hub' });
      }
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const now = deps().now();
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'origin_checkin',
            photoSha256: request.body.photoSha256,
            storageDeadlineAt: daysFromNow(now, bundle.shipment.maxStorageDays).toISOString(),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'AT_HUB' };
    },
  );

  // ------------------------------------------------------------- row 4
  // ADR-029: choosing a drop hub opens a deposit REQUEST (leg_request, no
  // money). When the hub auto-accepts, the API fires deposit_accept right
  // away — the pre-consent that preserves the old instant booking; when it is
  // manual, the request waits on the hub's dashboard (30-minute window) and
  // the hub is notified with the ADR-028 deposit-request email.
  app.post(
    '/shipments/:id/legs',
    { schema: { params, body: legAcceptBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const carrierId = request.userId!;
      const s = bundle.shipment;

      const [trip] = await app.db
        .select()
        .from(carrierTrips)
        .where(eq(carrierTrips.id, request.body.tripId));
      if (!trip || trip.userId !== carrierId) {
        return reply.code(404).send({ error: 'trip_not_found' });
      }
      const now = deps().now();
      const tripActive = trip.status === 'active' && trip.expiresAt.getTime() > now.getTime();

      const currentHub = currentHubOf(bundle);
      const toHub = bundle.hubById.get(request.body.toHubId) ??
        (await app.db.select().from(hubs).where(eq(hubs.id, request.body.toHubId)))[0];
      if (!currentHub) return reply.code(409).send({ error: 'not_at_hub' });
      if (!toHub || !toHub.active) return reply.code(404).send({ error: 'hub_not_found' });

      // Disjoint roles: every hold/fee of this leg needs payer ≠ payee.
      if (
        carrierId === s.senderId ||
        carrierId === currentHub.userId ||
        carrierId === toHub.userId ||
        toHub.userId === s.senderId
      ) {
        return reply.code(422).send({ error: 'self_payment_impossible' });
      }
      const problem = parcelFitsHub(s, toHub) ?? storageFitsHub(s.maxStorageDays, toHub);
      if (problem) return reply.code(422).send({ error: problem, hubId: toHub.id });

      const destHub = bundle.hubById.get(s.destHubId)!;
      const d = deps().distance.distanceKm.bind(deps().distance);
      const remainingKm = d(
        { lat: currentHub.lat, lng: currentHub.lng },
        { lat: destHub.lat, lng: destHub.lng },
      );
      const isFinal = toHub.id === s.destHubId;
      const progressKm = isFinal
        ? remainingKm
        : remainingKm - d({ lat: toHub.lat, lng: toHub.lng }, { lat: destHub.lat, lng: destHub.lng });

      let pricing;
      try {
        pricing = priceLeg({
          poolMsat: remainingWorkPool(bundle, remainingKm),
          totalKm: s.distanceKm,
          remainingKm,
          progressKm,
          depHubFeeBp: hubFeePercentToBp(currentHub.feePercent),
          arrHubFeeBp: hubFeePercentToBp(toHub.feePercent),
          carrierBonusMsat: bundle.carrierBonusAvailableMsat,
        });
      } catch (err) {
        if (err instanceof EconomicsError) {
          return reply.code(422).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      const finalizationHubBonusMsat = isFinal ? floorToSat(bundle.hubBonusAvailableMsat) : 0n;

      // The hub auto-accepts only if it opted in AND can bond (wallet). A
      // manual request notifies the hub (reusing the ADR-028 template) at its
      // venue contact address, falling back to the account email — the outbox
      // row rides the leg_request transaction (outbox invariant).
      const toHubWalletConnected = await hasConnectedWallet(app.db, toHub.userId);
      const willAutoAccept = toHub.autoAccept && toHubWalletConnected;
      let depositRequestTo: string | null = null;
      if (!willAutoAccept) {
        const [owner] = await app.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, toHub.userId));
        depositRequestTo = toHub.contactEmail ?? owner?.email ?? null;
      }

      const legId = randomUUID();
      const responseDeadlineAt = minutesFromNow(now, DEPOSIT_RESPONSE_WINDOW_MINUTES);
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: s.id,
          event: {
            type: 'leg_request',
            legId,
            carrierId,
            carrierWalletConnected: await hasConnectedWallet(app.db, carrierId),
            carrierTripActive: tripActive,
            toHubId: toHub.id,
            toHubUserId: toHub.userId,
            arrivalHubWalletConnected: toHubWalletConnected,
            pricing,
            finalizationHubBonusMsat,
            responseDeadlineAt: responseDeadlineAt.toISOString(),
          },
          legMeta: { tripId: trip.id, progressKm },
          ...(depositRequestTo && {
            persistBefore: async (tx: typeof app.db) => {
              await tx.insert(emailOutbox).values({
                to: depositRequestTo,
                template: 'hub_deposit_request',
                payload: {
                  shipmentId: s.id,
                  // The departure hub of the leg — where the parcel starts.
                  hubId: currentHub.id,
                  destHubId: s.destHubId,
                  maxStorageDays: s.maxStorageDays,
                  undeclared: s.undeclared,
                  legId,
                },
              });
            },
          }),
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }

      // Pre-consent (ADR-029 §2): fire the accept in its own transaction, as
      // shipment creation does for the origin hub. A failure leaves the leg
      // 'requested': the 30-minute window dissolves it back onto the board —
      // never a half-booked leg.
      let fundingDeadlineAt: Date | null = null;
      if (willAutoAccept) {
        const acceptNow = deps().now();
        const deadline = minutesFromNow(acceptNow, LEG_FUNDING_WINDOW_MINUTES);
        try {
          await executeShipmentTransition(deps(), {
            shipmentId: s.id,
            event: {
              type: 'deposit_accept',
              now: acceptNow.toISOString(),
              arrivalHubStayId: randomUUID(),
              arrivalHubWalletConnected: true,
              fundingDeadlineAt: deadline.toISOString(),
            },
          });
          fundingDeadlineAt = deadline;
        } catch (err) {
          request.log.warn({ err }, 'auto deposit-accept failed; leg stays requested');
        }
      }

      return reply.code(201).send({
        legId,
        status: fundingDeadlineAt ? 'pending_funding' : 'requested',
        responseDeadlineAt: responseDeadlineAt.toISOString(),
        fundingDeadlineAt: fundingDeadlineAt?.toISOString() ?? null,
        requiresHubConfirmation: !fundingDeadlineAt,
        pricing: {
          grossMsat: msat(pricing.grossMsat),
          depHubFeeMsat: msat(pricing.depHubFeeMsat),
          arrHubFeeMsat: msat(pricing.arrHubFeeMsat),
          netMsat: msat(pricing.netMsat),
          finalizationBonusMsat: msat(pricing.finalizationBonusMsat),
        },
        finalizationHubBonusMsat: msat(finalizationHubBonusMsat),
      });
    },
  );

  // ---------------------------------------------- ADR-029 deposit answers
  // The arrival hub answers a pending request from its dashboard; the
  // requesting carrier may withdraw. All three resolve the SAME requested
  // leg, so they share the params shape and the pending-request lookup.
  const legParams = z.object({ id: z.string().uuid(), legId: z.string().uuid() });

  app.post(
    '/shipments/:id/legs/:legId/deposit-accept',
    { schema: { params: legParams }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const req = bundle.ctx.pendingLegRequest;
      if (!req || req.legId !== request.params.legId) {
        return reply.code(409).send({ error: 'no_pending_deposit_request' });
      }
      if (req.toHubUserId !== request.userId) {
        return reply.code(403).send({ error: 'not_arrival_hub' });
      }
      // Same physical re-check as the origin accept: the hub's declared
      // constraints must still hold at the moment it commits its bond.
      const toHub = bundle.hubById.get(req.toHubId)!;
      const problem =
        parcelFitsHub(bundle.shipment, toHub) ??
        storageFitsHub(bundle.shipment.maxStorageDays, toHub);
      if (problem) return reply.code(422).send({ error: problem });

      const now = deps().now();
      const fundingDeadlineAt = minutesFromNow(now, LEG_FUNDING_WINDOW_MINUTES);
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'deposit_accept',
            now: now.toISOString(),
            arrivalHubStayId: randomUUID(),
            arrivalHubWalletConnected: await hasConnectedWallet(app.db, request.userId!),
            fundingDeadlineAt: fundingDeadlineAt.toISOString(),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'pending_funding', fundingDeadlineAt: fundingDeadlineAt.toISOString() };
    },
  );

  app.post(
    '/shipments/:id/legs/:legId/deposit-reject',
    { schema: { params: legParams, body: depositRejectBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const req = bundle.ctx.pendingLegRequest;
      if (!req || req.legId !== request.params.legId) {
        return reply.code(409).send({ error: 'no_pending_deposit_request' });
      }
      if (req.toHubUserId !== request.userId) {
        return reply.code(403).send({ error: 'not_arrival_hub' });
      }
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'deposit_reject',
            rejectedById: request.userId!,
            reason: request.body.reason,
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'AT_HUB' };
    },
  );

  app.post(
    '/shipments/:id/legs/:legId/deposit-cancel',
    { schema: { params: legParams }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const req = bundle.ctx.pendingLegRequest;
      if (!req || req.legId !== request.params.legId) {
        return reply.code(409).send({ error: 'no_pending_deposit_request' });
      }
      if (req.carrierId !== request.userId) {
        return reply.code(403).send({ error: 'not_the_requesting_carrier' });
      }
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: { type: 'deposit_request_cancel' },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'AT_HUB' };
    },
  );

  // ------------------------------------------------------------- row 6
  // Double-confirmation checkout: hub and carrier each confirm from their
  // own session within CHECKOUT_CONFIRMATION_WINDOW_MINUTES; the transition
  // fires with the second confirmation. The confirmations are coordination
  // metadata on the leg row — custody changes only in the machine.
  app.post(
    '/shipments/:id/pickup-checkout',
    { schema: { params, body: checkoutConfirmBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const legRow = bundle.activeLegRow;
      const hub = currentHubOf(bundle);
      if (!legRow || !hub || bundle.state !== 'LEG_BOOKED') {
        return reply.code(409).send({ error: 'no_booked_leg' });
      }
      const now = deps().now();
      const userId = request.userId!;

      let role: 'hub' | 'carrier';
      if (userId === hub.userId) {
        role = 'hub';
        if (!request.body.photoSha256 || request.body.photoSha256.length === 0) {
          return reply.code(422).send({ error: 'checkout_photo_required' });
        }
        await app.db
          .update(legs)
          .set({
            checkoutHubConfirmedAt: now,
            checkoutPhotoSha256: request.body.photoSha256,
          })
          .where(eq(legs.id, legRow.id));
      } else if (userId === legRow.carrierId) {
        role = 'carrier';
        await app.db
          .update(legs)
          .set({ checkoutCarrierConfirmedAt: now })
          .where(eq(legs.id, legRow.id));
      } else {
        return reply.code(403).send({ error: 'not_a_checkout_party' });
      }

      const [fresh] = await app.db.select().from(legs).where(eq(legs.id, legRow.id));
      const hubAt = fresh?.checkoutHubConfirmedAt ?? null;
      const carrierAt = fresh?.checkoutCarrierConfirmedAt ?? null;
      const windowMs = CHECKOUT_CONFIRMATION_WINDOW_MINUTES * 60 * 1000;
      const bothIn =
        hubAt !== null &&
        carrierAt !== null &&
        Math.abs(hubAt.getTime() - carrierAt.getTime()) <= windowMs;
      if (!bothIn) {
        return { confirmed: role, complete: false, status: bundle.state };
      }

      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'pickup_checkout',
            now: now.toISOString(),
            hubConfirmed: true,
            carrierConfirmed: true,
            photoSha256: (fresh?.checkoutPhotoSha256 as string[] | null) ?? [],
            transitDeadlineAt: hoursFromNow(now, TRANSIT_WINDOW_HOURS).toISOString(),
          },
        });
      } catch (err) {
        if (err instanceof ConflictError) {
          // The other party's request fired the transition first: done.
          return { confirmed: role, complete: true, status: 'IN_TRANSIT' };
        }
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { confirmed: role, complete: true, status: 'IN_TRANSIT' };
    },
  );

  // --------------------------------------------------------- rows 8/9
  app.post(
    '/shipments/:id/checkin',
    { schema: { params, body: legCheckinBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const leg = bundle.ctx.leg;
      if (!leg) return reply.code(409).send({ error: 'no_leg_in_transit' });
      const toHub = bundle.hubById.get(leg.toHubId);
      if (!toHub || toHub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_arrival_hub' });
      }
      const now = deps().now();
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'leg_checkin',
            now: now.toISOString(),
            hubId: toHub.id,
            integrityConfirmed: request.body.integrityConfirmed,
            photoSha256: request.body.photoSha256,
            storageDeadlineAt: daysFromNow(now, bundle.shipment.maxStorageDays).toISOString(),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      const arrived = toHub.id === bundle.shipment.destHubId;
      return { status: arrived ? 'AWAITING_PICKUP' : 'AT_HUB' };
    },
  );

  // ------------------------------------------------------------ row 10
  app.post(
    '/shipments/:id/return',
    { schema: { params, body: legReturnBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const leg = bundle.ctx.leg;
      if (!leg) return reply.code(409).send({ error: 'no_leg_in_transit' });
      const fromHub = bundle.hubById.get(leg.fromHubId);
      if (!fromHub || fromHub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_departure_hub' });
      }
      const now = deps().now();
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'leg_return',
            now: now.toISOString(),
            hubId: fromHub.id,
            returnHubStayId: randomUUID(),
            photoSha256: request.body.photoSha256,
            storageDeadlineAt: daysFromNow(now, bundle.shipment.maxStorageDays).toISOString(),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'AT_HUB' };
    },
  );

  // ------------------------------------------------------------ row 11
  app.post(
    '/shipments/:id/pickup',
    {
      schema: { params, body: recipientPickupBody },
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // OTP brute force
    },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const hub = currentHubOf(bundle);
      if (!hub || hub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_custodian_hub' });
      }
      // The API verifies the hash and hands the machine a FACT (precisazione
      // 10). A wrong OTP is a clean 422 before anything else moves.
      const otpVerified =
        bundle.shipment.recipientPickupOtpHash !== null &&
        hashToken(request.body.otp) === bundle.shipment.recipientPickupOtpHash;
      if (!otpVerified) return reply.code(422).send({ error: 'otp_invalid' });
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: { type: 'recipient_pickup', otpVerified },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'DELIVERED' };
    },
  );

  // ------------------------------------------------------------ row 18
  // Recipient claim (ADR-016): the recipient — authenticated, wallet
  // connected — claims the idle parcel with the bearer token from the
  // tracking mail. The route verifies the token hash and hands the machine
  // FACTS (precisazione 10); the amounts are frozen by the pure pricing
  // engine, never decided here.
  app.post(
    '/shipments/:id/claim',
    {
      schema: { params, body: recipientClaimBody },
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // token brute force
    },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const claimantId = request.userId!;
      const s = bundle.shipment;
      const claimTokenVerified =
        s.recipientClaimTokenHash !== null &&
        hashToken(request.body.claimToken) === s.recipientClaimTokenHash;
      if (!claimTokenVerified) return reply.code(422).send({ error: 'claim_token_invalid' });

      const currentHub = currentHubOf(bundle);
      if (!currentHub) return reply.code(409).send({ error: 'not_at_hub' });
      // Disjoint roles before any wallet is asked (Lightning: payer ≠ payee).
      if (claimantId === s.senderId || claimantId === currentHub.userId) {
        return reply.code(422).send({ error: 'self_payment_impossible' });
      }

      const destHub = bundle.hubById.get(s.destHubId)!;
      const remainingKm = deps().distance.distanceKm(
        { lat: currentHub.lat, lng: currentHub.lng },
        { lat: destHub.lat, lng: destHub.lng },
      );
      let pricing;
      try {
        pricing = priceClaim({
          poolMsat: remainingWorkPool(bundle, remainingKm),
          carrierBonusMsat: bundle.carrierBonusAvailableMsat,
          hubBonusMsat: bundle.hubBonusAvailableMsat,
        });
      } catch (err) {
        if (err instanceof EconomicsError) {
          return reply.code(422).send({ error: err.code, message: err.message });
        }
        throw err;
      }

      const claimId = randomUUID();
      const now = deps().now();
      const fundingDeadlineAt = minutesFromNow(now, LEG_FUNDING_WINDOW_MINUTES);
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: s.id,
          event: {
            type: 'recipient_claim',
            claimId,
            claimantId,
            claimantWalletConnected: await hasConnectedWallet(app.db, claimantId),
            claimTokenVerified,
            claimPaymentMsat: pricing.claimPaymentMsat,
            hubBonusMsat: pricing.hubBonusMsat,
            fundingDeadlineAt: fundingDeadlineAt.toISOString(),
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }

      return reply.code(201).send({
        claimId,
        status: 'pending_funding',
        claimPaymentMsat: msat(pricing.claimPaymentMsat),
        hubBonusMsat: msat(pricing.hubBonusMsat),
        fundingDeadlineAt: fundingDeadlineAt.toISOString(),
      });
    },
  );

  // ------------------------------------------------------------ row 21
  // Physical pickup of a claimed parcel (ADR-016): the custodian hub's
  // session scans the parcel QR and the claimant's token; the machine
  // settles the claim payment and Π_h and closes the shipment.
  app.post(
    '/shipments/:id/claimed-pickup',
    {
      schema: { params, body: claimedPickupBody },
      preHandler: requireAuth,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } }, // token brute force
    },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (!qrMatches(bundle, request.body.qrToken)) {
        return reply.code(403).send({ error: 'qr_mismatch' });
      }
      const hub = currentHubOf(bundle);
      if (!hub || hub.userId !== request.userId) {
        return reply.code(403).send({ error: 'not_custodian_hub' });
      }
      const s = bundle.shipment;
      const claimTokenVerified =
        s.recipientClaimTokenHash !== null &&
        hashToken(request.body.claimToken) === s.recipientClaimTokenHash;
      if (!claimTokenVerified) return reply.code(422).send({ error: 'claim_token_invalid' });
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: s.id,
          event: { type: 'recipient_claimed_pickup', claimTokenVerified },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'DELIVERED' };
    },
  );

  // ------------------------------------------------------------ row 12
  app.post(
    '/shipments/:id/reject',
    { schema: { params, body: handoffRejectBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const userId = request.userId!;
      const { stage, reason, photoSha256 } = request.body;

      // Who may reject depends on who is being handed the parcel.
      const allowed =
        (stage === 'pickup_checkout' && bundle.ctx.leg?.carrierId === userId) ||
        (stage === 'hub_checkin' &&
          bundle.ctx.leg &&
          bundle.hubById.get(bundle.ctx.leg.toHubId)?.userId === userId) ||
        (stage === 'recipient_pickup' && currentHubOf(bundle)?.userId === userId);
      if (!allowed) return reply.code(403).send({ error: 'not_the_receiving_party' });

      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'handoff_reject',
            stage,
            // The recipient has no account: the hub files on their behalf and
            // the chain records the filing user.
            rejectedById: userId,
            reason,
            photoSha256,
          },
          persistBefore: async (tx) => {
            await tx.insert(rejections).values({
              shipmentId: bundle.shipment.id,
              legId: bundle.ctx.leg?.legId ?? null,
              hubStayId: bundle.ctx.currentHubStay?.hubStayId ?? null,
              rejectedBy: userId,
              stage,
              reason,
            });
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: bundle.state };
    },
  );

  // ------------------------------------------------------------ row 15
  app.post(
    '/shipments/:id/boost',
    { schema: { params, body: boostBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (bundle.shipment.senderId !== request.userId) {
        return reply.code(403).send({ error: 'not_the_sender' });
      }
      const { idempotencyKey } = request.body;
      // A boost grows the sender's committed spend: a network retry must not
      // double it. The key lives in the custody payload (transport metadata).
      const [existing] = await app.db
        .select({ id: custodyEvents.id })
        .from(custodyEvents)
        .where(
          and(
            eq(custodyEvents.shipmentId, bundle.shipment.id),
            eq(custodyEvents.type, 'boosted'),
            sql`${custodyEvents.payload} ->> 'idempotencyKey' = ${idempotencyKey}`,
          ),
        );
      if (existing) return { status: bundle.state, deduplicated: true };

      // Remaining distance when the boost lands. At the destination hub
      // (AWAITING_PICKUP) the remaining distance is zero and the pool math
      // never consults this boost again in the current segment (a reroute
      // carries its work part over UNDECAYED — see the reroute handler):
      // the segment distance is recorded as a valid placeholder.
      const currentHub = currentHubOf(bundle);
      const destHub = bundle.hubById.get(bundle.shipment.destHubId);
      let atRemainingKm = bundle.shipment.distanceKm;
      if (bundle.state === 'AT_HUB' && currentHub && destHub) {
        atRemainingKm = deps().distance.distanceKm(
          { lat: currentHub.lat, lng: currentHub.lng },
          { lat: destHub.lat, lng: destHub.lng },
        );
      }
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: {
            type: 'boost',
            amountMsat: BigInt(request.body.amountMsat),
            atRemainingKm,
          },
          custodyPayloadExtra: { idempotencyKey },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: bundle.state, deduplicated: false };
    },
  );

  // ------------------------------------------------------------ row 16
  app.post(
    '/shipments/:id/reroute',
    { schema: { params, body: rerouteBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      const s = bundle.shipment;
      if (s.senderId !== request.userId) {
        return reply.code(403).send({ error: 'not_the_sender' });
      }
      const currentHub = currentHubOf(bundle);
      if (!currentHub) return reply.code(409).send({ error: 'parcel_not_idle_at_hub' });
      const { newDestHubId, newRecipientEmail } = request.body;
      const d = deps().distance.distanceKm.bind(deps().distance);

      let event;
      let shipmentPatch;
      if (newDestHubId) {
        const [newDest] = await app.db.select().from(hubs).where(eq(hubs.id, newDestHubId));
        if (!newDest || !newDest.active) return reply.code(404).send({ error: 'hub_not_found' });
        if (newDest.userId === s.senderId) {
          return reply.code(422).send({ error: 'sender_owns_hub' });
        }
        const problem = parcelFitsHub(s, newDest) ?? storageFitsHub(s.maxStorageDays, newDest);
        if (problem) return reply.code(422).send({ error: problem, hubId: newDest.id });
        const newRemainingKm = d(
          { lat: currentHub.lat, lng: currentHub.lng },
          { lat: newDest.lat, lng: newDest.lng },
        );
        if (!(newRemainingKm > 0)) return reply.code(422).send({ error: 'hubs_too_close' });

        // The reroute opens a fresh price segment (ECONOMICS.md §5-6): the
        // current pool — decayed boosts included — freezes as its commitment.
        // From AWAITING_PICKUP the old remaining distance is zero, so the
        // decayed pool is zero by construction; boosts made while waiting at
        // the destination never travelled and carry over UNDECAYED (they were
        // recorded for exactly this restart).
        let frozenWorkMsat: bigint;
        if (bundle.state === 'AWAITING_PICKUP') {
          frozenWorkMsat = postArrivalBoostWork(bundle);
        } else {
          const oldDest = bundle.hubById.get(s.destHubId)!;
          const oldRemainingKm = d(
            { lat: currentHub.lat, lng: currentHub.lng },
            { lat: oldDest.lat, lng: oldDest.lng },
          );
          frozenWorkMsat = applyReroute(
            s.segmentWorkMsat,
            s.distanceKm,
            Math.min(oldRemainingKm, s.distanceKm),
            newRemainingKm,
            bundle.segmentBoosts,
          ).offerMsat;
        }

        event = {
          type: 'reroute' as const,
          newDestHubId: newDest.id,
          newDestHubUserId: newDest.userId,
          newRecipientEmail: newRecipientEmail ?? null,
          newRemainingKm,
        };
        shipmentPatch = {
          destHubId: newDest.id,
          distanceKm: newRemainingKm,
          segmentWorkMsat: frozenWorkMsat,
          ...(newRecipientEmail && { recipientEmail: newRecipientEmail }),
        };
      } else {
        // Recipient-only change: no money, no segment change; the machine
        // rotates the OTP and (at the destination) re-invites immediately.
        const destHub = bundle.hubById.get(s.destHubId)!;
        const remainingKm =
          bundle.state === 'AWAITING_PICKUP'
            ? s.distanceKm // at destination r = 0; payload-only value must be > 0
            : d(
                { lat: currentHub.lat, lng: currentHub.lng },
                { lat: destHub.lat, lng: destHub.lng },
              );
        event = {
          type: 'reroute' as const,
          newDestHubId: null,
          newDestHubUserId: null,
          newRecipientEmail: newRecipientEmail ?? null,
          newRemainingKm: remainingKm,
        };
        shipmentPatch = { recipientEmail: newRecipientEmail! };
      }

      try {
        const outcome = await executeShipmentTransition(deps(), {
          shipmentId: s.id,
          event,
          shipmentPatch,
        });
        return { status: outcome.nextState };
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
    },
  );

  // ------------------------------------------------------------ row 17
  app.post(
    '/shipments/:id/cancel',
    { schema: { params }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadOr404(request.params.id, reply);
      if (!bundle) return;
      if (bundle.shipment.senderId !== request.userId) {
        return reply.code(403).send({ error: 'not_the_sender' });
      }
      try {
        await executeShipmentTransition(deps(), {
          shipmentId: bundle.shipment.id,
          event: { type: 'cancel' },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      return { status: 'CANCELLED' };
    },
  );
}

/** Σ work parts of boosts made while the parcel sat at the destination
 *  (chain order: boosted events after the last arrived_destination). */
function postArrivalBoostWork(bundle: ShipmentBundle): bigint {
  let afterArrival = false;
  let total = 0n;
  for (const event of bundle.chain) {
    if (event.type === 'arrived_destination') {
      afterArrival = true;
      total = 0n;
    } else if (event.type === 'rerouted') {
      afterArrival = false;
      total = 0n;
    } else if (afterArrival && event.type === 'boosted') {
      const payload = event.payload as { amountMsat?: string | number };
      const amount = BigInt(payload.amountMsat ?? 0);
      total += splitCommitment(amount).workMsat;
    }
  }
  return total;
}
