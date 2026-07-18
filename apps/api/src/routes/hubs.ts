// Hub discovery, the hub owner's deposit-request dashboard, and venue photos
// (ARCHITECTURE.md §4, CLAUDE.md "Hub — dettagli"; ADR-028 for Fase 2 punto 6).

import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { hubPhotos, hubs, hubStays, legs, shipments, walletConnections } from '@mercurio/db';
import { estimateHubFeeRange, splitCommitment } from '@mercurio/core';
import { hubFeePercentToBp, MAX_VENUE_PHOTOS, sha256String } from '@mercurio/shared';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { msat } from '../lib/serialize.js';
import { loadRatings, ratingOf } from '../lib/reviews.js';
import { sha256Hex } from '../lib/blob-store.js';
import { isJpeg, jpegHasGpsExif } from '../lib/photo-validation.js';
import { PHOTO_MAX_BYTES } from '@mercurio/shared';

const hubParams = z.object({ id: z.string().uuid() });
const venuePhotoParams = z.object({ id: z.string().uuid(), sha256: sha256String });
const mineVenuePhotoParams = z.object({ sha256: sha256String });

// Leg statuses whose frozen hub fees are a REAL earning for the hub: a leg that
// reached LEG_BOOKED (bond held) or beyond. pending_funding/expired/failed/
// returned never certified an adjacent handoff for this hub.
const EARNING_LEG_STATUSES = ['booked', 'picked_up', 'completed'] as const;

export function registerHubRoutes(app: App) {
  /** Public list of active hubs — the sender picks origin/destination here,
   *  so each hub carries its owner's hub-role rating (CLAUDE.md: rating
   *  visible wherever a counterparty is chosen) and its venue photos. */
  app.get('/hubs', async () => {
    const rows = await app.db.select().from(hubs).where(eq(hubs.active, true));
    const owners = rows.map((h) => h.userId);
    const hubIds = rows.map((h) => h.id);
    const ratings = await loadRatings(
      app.db,
      owners.map((userId) => ({ userId, role: 'hub' as const })),
    );
    const connected = new Set(
      owners.length === 0
        ? []
        : (
            await app.db
              .select({ userId: walletConnections.userId })
              .from(walletConnections)
              .where(
                and(
                  inArray(walletConnections.userId, owners),
                  eq(walletConnections.status, 'connected'),
                ),
              )
          ).map((r) => r.userId),
    );
    // Venue photos (ADR-028), grouped per hub — a public asset served bytes-only
    // from GET /hubs/:id/venue-photos/:sha256.
    const venueRows =
      hubIds.length === 0
        ? []
        : await app.db
            .select({ hubId: hubPhotos.hubId, sha256: hubPhotos.sha256 })
            .from(hubPhotos)
            .where(inArray(hubPhotos.hubId, hubIds))
            .orderBy(asc(hubPhotos.createdAt));
    const venueByHub = new Map<string, string[]>();
    for (const v of venueRows) {
      const list = venueByHub.get(v.hubId) ?? [];
      list.push(v.sha256);
      venueByHub.set(v.hubId, list);
    }
    return {
      hubs: rows.map((h) => ({
        id: h.id,
        name: h.name,
        address: h.address,
        lat: h.lat,
        lng: h.lng,
        feePercent: h.feePercent,
        maxDims: { lengthCm: h.maxDimCmL, widthCm: h.maxDimCmW, heightCm: h.maxDimCmH },
        maxWeightG: h.maxWeightG,
        acceptsUndeclared: h.acceptsUndeclared,
        maxStorageDays: h.maxStorageDays,
        openingHours: h.openingHours as Record<string, string>,
        autoAccept: h.autoAccept,
        walletConnected: connected.has(h.userId),
        rating: ratingOf(ratings, h.userId, 'hub'),
        venuePhotos: venueByHub.get(h.id) ?? [],
      })),
    };
  });

  /** The hub owner's dashboard: deposit requests waiting for this hub's
   *  answer — origin DRAFTs and, since ADR-029, arrival `requested` legs
   *  (punto 9: pinned on top, ordered by response deadline) — and every stay
   *  currently reserved or hosted here. Each row carries what the hub would
   *  earn from it (Fase 2 punto 7): the exact frozen fee where an adjacent
   *  leg is priced, an estimated "from–to" range where the leg split is not
   *  known yet. */
  app.get('/hubs/mine/requests', { preHandler: requireAuth }, async (request, reply) => {
    const [hub] = await app.db.select().from(hubs).where(eq(hubs.userId, request.userId!));
    if (!hub) return reply.code(404).send({ error: 'not_a_hub' });
    const feeBp = hubFeePercentToBp(hub.feePercent);

    const [pendingAccept, stays, arrivalRequests] = await Promise.all([
      app.db
        .select()
        .from(shipments)
        .where(and(eq(shipments.originHubId, hub.id), eq(shipments.status, 'draft'))),
      app.db
        .select({ stay: hubStays, shipment: shipments })
        .from(hubStays)
        .innerJoin(shipments, eq(shipments.id, hubStays.shipmentId))
        .where(
          and(eq(hubStays.hubId, hub.id), inArray(hubStays.status, ['reserved', 'active'])),
        ),
      // ADR-029 / punto 9: deposit requests pending on THIS hub as the
      // arrival of a requested leg — the manual accept/reject queue.
      app.db
        .select({ leg: legs, shipment: shipments })
        .from(legs)
        .innerJoin(shipments, eq(shipments.id, legs.shipmentId))
        .where(and(eq(legs.toHubId, hub.id), eq(legs.status, 'requested'))),
    ]);

    // Frozen fees on the legs adjacent to these stays that touch THIS hub: the
    // arrival fee of a leg dropping here (to_hub) plus the departure fee of a
    // leg leaving here (from_hub). One query for all stays' shipments.
    const stayShipmentIds = [...new Set(stays.map((s) => s.shipment.id))];
    const adjacentLegs =
      stayShipmentIds.length === 0
        ? []
        : await app.db
            .select()
            .from(legs)
            .where(
              and(
                inArray(legs.shipmentId, stayShipmentIds),
                inArray(legs.status, [...EARNING_LEG_STATUSES]),
              ),
            );
    const frozenFeeFor = (shipmentId: string): bigint => {
      let total = 0n;
      for (const leg of adjacentLegs) {
        if (leg.shipmentId !== shipmentId) continue;
        if (leg.toHubId === hub.id) total += leg.arrHubFeeMsat;
        if (leg.fromHubId === hub.id) total += leg.depHubFeeMsat;
      }
      return total;
    };

    // Range for a leg whose split is not known: origin drop, r = D and the pool
    // is the whole work split of the offer. (A stay with no frozen adjacent fee
    // is necessarily at the origin — every other hub the parcel reaches did so
    // through a completed check-in, whose arrival fee is already frozen.)
    const rangeFromOffer = (offerMsat: bigint, distanceKm: number) => {
      const r = estimateHubFeeRange({
        poolMsat: splitCommitment(offerMsat).workMsat,
        totalKm: distanceKm,
        remainingKm: distanceKm,
        hubFeeBp: feeBp,
      });
      return { kind: 'range' as const, minMsat: msat(r.minMsat), maxMsat: msat(r.maxMsat) };
    };

    return {
      hubId: hub.id,
      // Arrival deposit requests (ADR-029), soonest response deadline first —
      // punto 9 pins these on top: the 30-minute clock is already running.
      // The earning is EXACT: the leg's arrival fee was frozen at the request.
      depositRequests: arrivalRequests
        .sort(
          (a, b) =>
            (a.leg.responseDeadlineAt?.getTime() ?? 0) -
            (b.leg.responseDeadlineAt?.getTime() ?? 0),
        )
        .map(({ leg, shipment }) => ({
          shipmentId: shipment.id,
          legId: leg.id,
          codename: shipment.codename,
          fromHubId: leg.fromHubId,
          destHubId: shipment.destHubId,
          dims: { lengthCm: shipment.dimLCm, widthCm: shipment.dimWCm, heightCm: shipment.dimHCm },
          weightG: shipment.weightG,
          undeclared: shipment.undeclared,
          custodyBondMsat: msat(shipment.custodyBondMsat),
          maxStorageDays: shipment.maxStorageDays,
          responseDeadlineAt: leg.responseDeadlineAt?.toISOString() ?? null,
          projectedEarning: { kind: 'exact' as const, msat: msat(leg.arrHubFeeMsat) },
          eurRate: {
            satsPerEur: shipment.eurRateSnapshot,
            source: shipment.eurRateSource,
            at: shipment.eurRateAt.toISOString(),
          },
          requestedAt: leg.acceptedAt.toISOString(),
        })),
      acceptRequests: pendingAccept.map((s) => ({
        shipmentId: s.id,
        codename: s.codename,
        destHubId: s.destHubId,
        dims: { lengthCm: s.dimLCm, widthCm: s.dimWCm, heightCm: s.dimHCm },
        weightG: s.weightG,
        undeclared: s.undeclared,
        custodyBondMsat: msat(s.custodyBondMsat),
        maxStorageDays: s.maxStorageDays,
        // No leg accepted yet: the earning is an estimate over the first leg.
        projectedEarning: rangeFromOffer(s.offerMsat, s.distanceKm),
        // Frozen snapshot (ADR-008): the "≈ €" of bond and earning uses the
        // shipment's rate.
        eurRate: {
          satsPerEur: s.eurRateSnapshot,
          source: s.eurRateSource,
          at: s.eurRateAt.toISOString(),
        },
        createdAt: s.createdAt.toISOString(),
      })),
      stays: stays.map(({ stay, shipment }) => {
        const frozen = frozenFeeFor(shipment.id);
        return {
          hubStayId: stay.id,
          shipmentId: stay.shipmentId,
          codename: shipment.codename,
          status: stay.status,
          shipmentStatus: shipment.status,
          storageDeadlineAt: stay.storageDeadlineAt?.toISOString() ?? null,
          custodyBondMsat: msat(shipment.custodyBondMsat),
          // Exact where an adjacent leg is priced; otherwise a range (origin
          // stay before the first leg).
          projectedEarning:
            frozen > 0n
              ? { kind: 'exact' as const, msat: msat(frozen) }
              : rangeFromOffer(shipment.offerMsat, shipment.distanceKm),
          eurRate: {
            satsPerEur: shipment.eurRateSnapshot,
            source: shipment.eurRateSource,
            at: shipment.eurRateAt.toISOString(),
          },
          // The dashboard identifies a stay by where the parcel is headed
          // (hub name), never a truncated shipment id.
          destHubId: shipment.destHubId,
        };
      }),
    };
  });

  // ---------------------------------------------------------- venue photos
  // Public read: the storefront is decision-relevant when picking a hub, so no
  // session is required (ADR-028) — unlike shipment photos (ADR-020 §4).

  app.get('/hubs/:id/venue-photos', { schema: { params: hubParams } }, async (request) => {
    const rows = await app.db
      .select({ sha256: hubPhotos.sha256, createdAt: hubPhotos.createdAt })
      .from(hubPhotos)
      .where(eq(hubPhotos.hubId, request.params.id))
      .orderBy(asc(hubPhotos.createdAt));
    return {
      photos: rows.map((p) => ({ sha256: p.sha256, createdAt: p.createdAt.toISOString() })),
    };
  });

  app.get(
    '/hubs/:id/venue-photos/:sha256',
    { schema: { params: venuePhotoParams } },
    async (request, reply) => {
      const { id, sha256 } = request.params;
      const [row] = await app.db
        .select({ storageKey: hubPhotos.storageKey })
        .from(hubPhotos)
        .where(and(eq(hubPhotos.hubId, id), eq(hubPhotos.sha256, sha256)));
      const bytes = row ? await app.venueBlobStore.get(row.storageKey) : null;
      if (!bytes) return reply.code(404).send({ error: 'not_found' });
      // Public asset: a shared cache is fine (unlike private shipment photos).
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'public, max-age=3600')
        .send(bytes);
    },
  );

  // Owner-only management. The upload mirrors the shipment photo contract
  // (ADR-020 §2-3): the client strips EXIF and re-encodes ON DEVICE before
  // hashing; the server VERIFIES the hash, the JPEG magic bytes and the absence
  // of a GPS EXIF block, and never rewrites the bytes. It differs only in the
  // authorization: no custody chain — the hub owns its venue photos outright.
  app.post(
    '/hubs/mine/venue-photos/:sha256',
    {
      schema: {
        params: mineVenuePhotoParams,
        description:
          'Uploads a venue photo of the caller\'s hub (raw image/jpeg body). The ' +
          'bytes must hash to :sha256. Clients MUST strip EXIF metadata ' +
          '(re-encode) on the device BEFORE hashing: the server refuses JPEGs ' +
          'carrying a GPS EXIF block (photo_exif_gps) and never rewrites bytes.',
      },
      preHandler: requireAuth,
      bodyLimit: PHOTO_MAX_BYTES,
    },
    async (request, reply) => {
      const { sha256 } = request.params;
      const [hub] = await app.db.select().from(hubs).where(eq(hubs.userId, request.userId!));
      if (!hub) return reply.code(404).send({ error: 'not_a_hub' });

      const [existing] = await app.db
        .select({ id: hubPhotos.id })
        .from(hubPhotos)
        .where(and(eq(hubPhotos.hubId, hub.id), eq(hubPhotos.sha256, sha256)));
      if (existing) return { sha256, duplicated: true };

      const count = (
        await app.db.select({ id: hubPhotos.id }).from(hubPhotos).where(eq(hubPhotos.hubId, hub.id))
      ).length;
      if (count >= MAX_VENUE_PHOTOS) {
        return reply.code(422).send({ error: 'venue_photos_full', max: MAX_VENUE_PHOTOS });
      }

      const bytes = request.body as Buffer;
      if (!Buffer.isBuffer(bytes) || !isJpeg(bytes)) {
        return reply.code(422).send({ error: 'photo_format_unsupported' });
      }
      if (sha256Hex(bytes) !== sha256) {
        return reply.code(422).send({ error: 'photo_hash_mismatch' });
      }
      if (jpegHasGpsExif(bytes)) {
        return reply.code(422).send({ error: 'photo_exif_gps' });
      }

      // Blob first, row second: a crash between them leaves an orphan blob (the
      // venue store has no purge worker, so an admin sweep would reclaim it) —
      // never a row whose bytes were lost.
      await app.venueBlobStore.put(sha256, bytes);
      await app.db
        .insert(hubPhotos)
        .values({ hubId: hub.id, kind: 'hub_venue', storageKey: sha256, sha256 });
      return reply.code(201).send({ sha256, duplicated: false });
    },
  );

  app.delete(
    '/hubs/mine/venue-photos/:sha256',
    { schema: { params: mineVenuePhotoParams }, preHandler: requireAuth },
    async (request, reply) => {
      const { sha256 } = request.params;
      const [hub] = await app.db.select().from(hubs).where(eq(hubs.userId, request.userId!));
      if (!hub) return reply.code(404).send({ error: 'not_a_hub' });

      const [row] = await app.db
        .select({ id: hubPhotos.id, storageKey: hubPhotos.storageKey })
        .from(hubPhotos)
        .where(and(eq(hubPhotos.hubId, hub.id), eq(hubPhotos.sha256, sha256)));
      if (!row) return reply.code(404).send({ error: 'not_found' });

      await app.db.delete(hubPhotos).where(eq(hubPhotos.id, row.id));
      // Content-addressed dedup: drop the blob only when no venue-photo row (any
      // hub) still references it.
      const [stillReferenced] = await app.db
        .select({ id: hubPhotos.id })
        .from(hubPhotos)
        .where(eq(hubPhotos.storageKey, row.storageKey))
        .limit(1);
      if (!stillReferenced) await app.venueBlobStore.delete(row.storageKey);
      return { deleted: true };
    },
  );
}
