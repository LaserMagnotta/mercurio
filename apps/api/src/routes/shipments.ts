// Shipment creation and read endpoints (flow steps 1–2 of CLAUDE.md).
//
// Creation freezes everything volatile ONCE: the EUR exchange snapshot and
// the origin→destination distance D (ADR-008, ECONOMICS.md §2), the QR token
// and the ADR-014 work split of the offer. If the origin hub auto-accepts,
// the accept transition runs immediately after (its own transaction): the
// sender walks out with a printable QR and a hub already bonded.

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { hubs, legs, shipmentClaims, shipments } from '@mercurio/db';
import { splitCommitment } from '@mercurio/core';
import {
  createShipmentBody,
  MAX_CUSTODY_BOND_EUR,
  type ShipmentContext,
} from '@mercurio/shared';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { generateToken } from '../lib/tokens.js';
import { mintCodename } from '../lib/codename.js';
import { eurToMsat, type EurRateSnapshot } from '../lib/eur-rate.js';
import { hasConnectedWallet } from '../lib/wallets.js';
import { parcelFitsHub, storageFitsHub } from '../lib/parcel.js';
import { msat, isoOrNull } from '../lib/serialize.js';
import { executeShipmentTransition } from '../shipments/executor.js';
import { loadShipmentBundle, remainingWorkPool } from '../shipments/context.js';
import { effectiveParticipants, loadRatings, ratingOf } from '../lib/reviews.js';
import { replyLifecycleError } from './lifecycle-errors.js';

const shipmentParams = z.object({ id: z.string().uuid() });
const qrParams = z.object({ qrToken: z.string().min(1) });

export function registerShipmentRoutes(app: App) {
  app.post(
    '/shipments',
    { schema: { body: createShipmentBody }, preHandler: requireAuth },
    async (request, reply) => {
      const b = request.body;
      const senderId = request.userId!;
      const deps = app.lifecycle;

      const hubRows = await app.db
        .select()
        .from(hubs)
        .where(inArray(hubs.id, [b.originHubId, b.destHubId]));
      const originHub = hubRows.find((h) => h.id === b.originHubId);
      const destHub = hubRows.find((h) => h.id === b.destHubId);
      if (!originHub || !destHub || !originHub.active || !destHub.active) {
        return reply.code(404).send({ error: 'hub_not_found' });
      }
      // Self-payments are impossible on Lightning (payer must differ from
      // payee): the sender cannot use a hub they own as origin/destination —
      // the hub bond / finalization-bonus holds would be self-directed.
      if (originHub.userId === senderId || destHub.userId === senderId) {
        return reply.code(422).send({ error: 'sender_owns_hub' });
      }
      const parcel = {
        dimLCm: b.dims.lengthCm,
        dimWCm: b.dims.widthCm,
        dimHCm: b.dims.heightCm,
        weightG: b.weightG,
        undeclared: b.undeclared,
      };
      for (const hub of [originHub, destHub]) {
        const problem = parcelFitsHub(parcel, hub) ?? storageFitsHub(b.maxStorageDays, hub);
        if (problem) return reply.code(422).send({ error: problem, hubId: hub.id });
      }

      const offerMsat = BigInt(b.offerMsat);
      const custodyBondMsat = BigInt(b.custodyBondMsat);
      // The one place a NEW rate is required: it sizes the ToS bond cap below
      // and is then frozen on the row for the shipment's whole life (ADR-008).
      // A rate too old to be trusted fails here as a typed 503 — the sender
      // retries with no funds committed. Every other flow reads the frozen
      // column instead, so none of them can stall on a dead feed (ADR-025).
      let rate: EurRateSnapshot;
      try {
        rate = await app.eurRate.snapshot('freeze');
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }
      const bondCapMsat = eurToMsat(MAX_CUSTODY_BOND_EUR, rate.satsPerEur);
      if (custodyBondMsat > bondCapMsat) {
        return reply
          .code(422)
          .send({ error: 'bond_above_cap', capMsat: msat(bondCapMsat) });
      }

      const distanceKm = deps.distance.distanceKm(
        { lat: originHub.lat, lng: originHub.lng },
        { lat: destHub.lat, lng: destHub.lng },
      );
      if (!(distanceKm > 0)) return reply.code(422).send({ error: 'hubs_too_close' });

      const shipmentId = randomUUID();
      const qrToken = generateToken().token;
      const codename = await mintCodename(app.db);
      const segmentWorkMsat = splitCommitment(offerMsat).workMsat;
      const senderWalletConnected = await hasConnectedWallet(app.db, senderId);

      const createCtx: ShipmentContext = {
        shipmentId,
        senderId,
        senderWalletConnected,
        originHubId: originHub.id,
        originHubUserId: originHub.userId,
        destHubId: destHub.id,
        custodyBondMsat,
        offerMsat,
        workCommitmentMsat: segmentWorkMsat,
        originHubFeeBp: 0, // unused by `create`; the real value loads from DB later
        currentHubStay: null,
        leg: null,
        finalizationBonusHold: null,
        pendingClaim: null,
      };

      try {
        await executeShipmentTransition(deps, {
          shipmentId,
          // The optional creation-photo hashes ride the event into the
          // `created` payload — the shipment's certification record (ADR-022);
          // the bytes arrive later through POST /shipments/:id/photos/:sha256.
          event: {
            type: 'create',
            ...(b.contentPhotoSha256 && { contentPhotoSha256: b.contentPhotoSha256 }),
            ...(b.sealedPhotoSha256 && { sealedPhotoSha256: b.sealedPhotoSha256 }),
          },
          createCtx,
          persistBefore: async (tx) => {
            await tx.insert(shipments).values({
              id: shipmentId,
              senderId,
              originHubId: originHub.id,
              destHubId: destHub.id,
              recipientEmail: b.recipientEmail,
              qrToken,
              codename,
              dimLCm: parcel.dimLCm,
              dimWCm: parcel.dimWCm,
              dimHCm: parcel.dimHCm,
              weightG: parcel.weightG,
              declaredContent: b.declaredContent ?? null,
              undeclared: b.undeclared,
              offerMsat,
              segmentWorkMsat,
              custodyBondMsat,
              maxStorageDays: b.maxStorageDays,
              eurRateSnapshot: rate.satsPerEur,
              eurRateSource: rate.source,
              eurRateAt: rate.at,
              status: 'draft',
              distanceKm,
            });
          },
        });
      } catch (err) {
        if (await replyLifecycleError(reply, err)) return;
        throw err;
      }

      // Flow step 3: the hub "ha accettato in anticipo" — auto_accept means
      // the hub consented to bond automatically whatever fits its declared
      // constraints (already validated above). Failure leaves DRAFT and the
      // manual accept endpoint available: creation never rolls back for it.
      let originAccepted = false;
      if (originHub.autoAccept && (await hasConnectedWallet(app.db, originHub.userId))) {
        try {
          await executeShipmentTransition(deps, {
            shipmentId,
            event: {
              type: 'origin_hub_accept',
              hubStayId: randomUUID(),
              hubWalletConnected: true,
            },
          });
          originAccepted = true;
        } catch (err) {
          request.log.warn({ err }, 'origin auto-accept failed; shipment stays DRAFT');
        }
      }

      return reply.code(201).send({
        id: shipmentId,
        codename,
        status: originAccepted ? 'AWAITING_DROPOFF' : 'DRAFT',
        qrToken,
        distanceKm,
        segmentWorkMsat: msat(segmentWorkMsat),
        eurRate: {
          satsPerEur: rate.satsPerEur,
          source: rate.source,
          at: rate.at.toISOString(),
        },
        originAccepted,
      });
    },
  );

  /** Participant view: sender, origin/destination hub owners, any carrier of
   *  a leg, the current custodian. 404 for everyone else (never leak). */
  app.get(
    '/shipments/:id',
    { schema: { params: shipmentParams }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadShipmentBundle(app.db, request.params.id);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });
      const userId = request.userId!;
      const s = bundle.shipment;
      const hubOwners = [...bundle.hubById.values()].map((h) => h.userId);
      const legRowsAll = await app.db.select().from(legs).where(eq(legs.shipmentId, s.id));
      const claimRowsAll = await app.db
        .select({ claimantId: shipmentClaims.claimantId })
        .from(shipmentClaims)
        .where(eq(shipmentClaims.shipmentId, s.id));
      const isParticipant =
        s.senderId === userId ||
        hubOwners.includes(userId) ||
        legRowsAll.some((l) => l.carrierId === userId) ||
        // A claimant is a party to the shipment (ADR-016): they need the
        // status to know when the claim is funded and pickup can happen.
        claimRowsAll.some((c) => c.claimantId === userId);
      if (!isParticipant) return reply.code(404).send({ error: 'not_found' });

      // Ratings of the effective participants (ADR-017), but ONLY the hubs are
      // reviewable now (ADR-027): the detail shows hub aggregates only. The
      // full participant set still decides `viewerCanReview` below — a sender
      // or carrier is an author (they rate the hubs) even though neither is a
      // reviewable subject.
      const participants = await effectiveParticipants(app.db, {
        id: s.id,
        senderId: s.senderId,
      });
      const viewerCanReview = participants.some((p) => p.userId === userId);
      const hubParticipants = participants.filter((p) => p.role === 'hub');
      const ratings = await loadRatings(app.db, hubParticipants);

      const currentHubId = bundle.currentStayRow?.hubId ?? null;
      const destHub = bundle.hubById.get(s.destHubId);
      const remainingKm =
        currentHubId && destHub
          ? app.lifecycle.distance.distanceKm(
              {
                lat: bundle.hubById.get(currentHubId)!.lat,
                lng: bundle.hubById.get(currentHubId)!.lng,
              },
              { lat: destHub.lat, lng: destHub.lng },
            )
          : null;

      return {
        id: s.id,
        codename: s.codename,
        status: bundle.state,
        senderId: s.senderId,
        originHubId: s.originHubId,
        destHubId: s.destHubId,
        currentHubId,
        ...(s.senderId === userId && { qrToken: s.qrToken, recipientEmail: s.recipientEmail }),
        dims: { lengthCm: s.dimLCm, widthCm: s.dimWCm, heightCm: s.dimHCm },
        weightG: s.weightG,
        declaredContent: s.declaredContent,
        undeclared: s.undeclared,
        offerMsat: msat(s.offerMsat),
        segmentWorkMsat: msat(s.segmentWorkMsat),
        remainingPoolMsat:
          remainingKm !== null && remainingKm > 0
            ? msat(remainingWorkPool(bundle, remainingKm))
            : msat(0n),
        custodyBondMsat: msat(s.custodyBondMsat),
        maxStorageDays: s.maxStorageDays,
        distanceKm: s.distanceKm,
        remainingKm,
        eurRate: {
          satsPerEur: s.eurRateSnapshot,
          source: s.eurRateSource,
          at: s.eurRateAt.toISOString(),
        },
        createdAt: s.createdAt.toISOString(),
        legs: legRowsAll
          .sort((a, b) => a.seq - b.seq)
          .map((l) => ({
            id: l.id,
            seq: l.seq,
            status: l.status,
            carrierId: l.carrierId,
            fromHubId: l.fromHubId,
            toHubId: l.toHubId,
            progressKm: l.progressKm,
            grossMsat: msat(l.grossMsat),
            depHubFeeMsat: msat(l.depHubFeeMsat),
            arrHubFeeMsat: msat(l.arrHubFeeMsat),
            netMsat: msat(l.netMsat),
            finalizationBonusMsat: msat(l.finalizationBonusMsat),
            fundingDeadlineAt: l.fundingDeadlineAt.toISOString(),
            pickupDeadlineAt: isoOrNull(l.pickupDeadlineAt),
            transitDeadlineAt: isoOrNull(l.transitDeadlineAt),
          })),
        custodyChain: bundle.chain.map((e) => ({
          type: e.type,
          actorUserId: e.actorUserId,
          legId: e.legId,
          hubStayId: e.hubStayId,
          payload: e.payload as Record<string, unknown>,
          hash: e.hash,
          createdAt: e.createdAt.toISOString(),
        })),
        // Hub-only (ADR-027): the reviewable subjects and their aggregates.
        ratings: hubParticipants.map((p) => ({
          userId: p.userId,
          role: p.role,
          hubId: p.hubId,
          ...ratingOf(ratings, p.userId, p.role),
        })),
        // Whether the viewer is an effective participant and so may author a
        // hub review (the web review form gates on this, not on `ratings`).
        viewerCanReview,
      };
    },
  );

  /** Public status by QR scan (ARCHITECTURE.md §7): the QR identifies, it
   *  never authorizes — whoever frames it sees at most this. */
  app.get('/shipments/by-qr/:qrToken', { schema: { params: qrParams } }, async (request, reply) => {
    const [s] = await app.db
      .select()
      .from(shipments)
      .where(eq(shipments.qrToken, request.params.qrToken));
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const hubRows = await app.db
      .select({ id: hubs.id, name: hubs.name })
      .from(hubs)
      .where(inArray(hubs.id, [s.originHubId, s.destHubId]));
    const name = (id: string) => hubRows.find((h) => h.id === id)?.name ?? '—';
    return {
      codename: s.codename,
      status: s.status.toUpperCase(),
      originHubName: name(s.originHubId),
      destHubName: name(s.destHubId),
    };
  });
}
