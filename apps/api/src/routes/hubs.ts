// Hub discovery, the hub owner's deposit-request dashboard, and venue photos
// (ARCHITECTURE.md §4, CLAUDE.md "Hub — dettagli"; ADR-028 for Fase 2 punto 6;
// ADR-030 for discovery at 10k-hub scale: bbox + text search + pagination and
// the per-hub "waiting shipments" view for reverse trip planning).

import { and, eq, gte, ilike, inArray, lte, or, asc } from 'drizzle-orm';
import { z } from 'zod';
import {
  hubPhotos,
  hubs,
  hubStays,
  legs,
  shipmentClaims,
  shipments,
  walletConnections,
} from '@mercurio/db';
import { estimateHubFeeRange, splitCommitment } from '@mercurio/core';
import {
  hubFeePercentToBp,
  hubsListQuery,
  MAX_VENUE_PHOTOS,
  type OpeningHoursEntry,
  sha256String,
} from '@mercurio/shared';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { msat } from '../lib/serialize.js';
import { loadRatings, ratingOf } from '../lib/reviews.js';
import { sha256Hex } from '../lib/blob-store.js';
import { isJpeg, jpegHasGpsExif } from '../lib/photo-validation.js';
import { PHOTO_MAX_BYTES } from '@mercurio/shared';
import { loadShipmentBundle, remainingWorkPool } from '../shipments/context.js';
import { hasPair, pairKeyOf, pointKeyOf } from '../lib/road-routing.js';

const hubParams = z.object({ id: z.string().uuid() });
const venuePhotoParams = z.object({ id: z.string().uuid(), sha256: sha256String });
const mineVenuePhotoParams = z.object({ sha256: sha256String });

/** Escape LIKE wildcards in user text: a search for "100%" must not scan. */
const escapeLike = (q: string) => q.replace(/[\\%_]/g, '\\$&');

// Leg statuses whose adjacent hub fees are already FROZEN and belong in the
// stay's projection: everything from deposit_accept on (the fee froze at
// leg_request; pending_funding merely waits for the wallets, and if funding
// expires the stay dissolves with the leg — the dashboard just refreshes).
// 'requested' stays out: its arrival side is surfaced as a depositRequest,
// and its departure fee would price a hop the arrival hub never confirmed.
const PRICED_LEG_STATUSES = ['pending_funding', 'booked', 'picked_up', 'completed'] as const;

export function registerHubRoutes(app: App) {
  type HubRow = typeof hubs.$inferSelect;

  /** Ratings, wallet flags and venue photos for ONE PAGE of hubs — never for
   *  the whole table (ADR-030: the page is bounded, the table is not). */
  async function hubDtos(rows: HubRow[], nearPoint: { lat: number; lng: number } | null) {
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
    const d = app.lifecycle.distance.distanceKm.bind(app.lifecycle.distance);
    return rows.map((h) => ({
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
      openingHours: h.openingHours as OpeningHoursEntry[],
      autoAccept: h.autoAccept,
      walletConnected: connected.has(h.userId),
      rating: ratingOf(ratings, h.userId, 'hub'),
      venuePhotos: venueByHub.get(h.id) ?? [],
      ...(nearPoint && {
        distanceKm: d(nearPoint, { lat: h.lat, lng: h.lng }),
      }),
    }));
  }

  /** Public hub discovery (ADR-030) — the sender picks origin/destination
   *  here and the carrier scouts the network. Always paginated: bbox
   *  viewport filter, case-insensitive text search, distance sort from
   *  `near`, limit/offset with the pre-pagination `total`. The unbounded
   *  legacy list (no params = whole table) retired with Fase 5, once the
   *  last internal picker moved to search: a bare GET /hubs now returns the
   *  first page of 50. */
  app.get('/hubs', { schema: { querystring: hubsListQuery } }, async (request, reply) => {
    const { bbox, q, near, limit, offset } = request.query;

    const conditions = [eq(hubs.active, true)];
    if (bbox) {
      const [minLat, minLng, maxLat, maxLng] = bbox.split(',').map(Number) as [
        number,
        number,
        number,
        number,
      ];
      if (!(minLat < maxLat) || !(minLng < maxLng)) {
        return reply.code(400).send({ error: 'invalid_bbox' });
      }
      conditions.push(
        gte(hubs.lat, minLat),
        lte(hubs.lat, maxLat),
        gte(hubs.lng, minLng),
        lte(hubs.lng, maxLng),
      );
    }
    if (q) {
      const like = `%${escapeLike(q)}%`;
      conditions.push(or(ilike(hubs.name, like), ilike(hubs.address, like))!);
    }

    // The filtered set is bounded by the viewport/search; the distance sort
    // runs on it in process (ADR-007 haversine — no PostGIS in the MVP).
    let rows = await app.db.select().from(hubs).where(and(...conditions));
    const total = rows.length;
    let nearPoint: { lat: number; lng: number } | null = null;
    if (near) {
      const [lat, lng] = near.split(',').map(Number) as [number, number];
      nearPoint = { lat, lng };
      const d = app.lifecycle.distance.distanceKm.bind(app.lifecycle.distance);
      rows = [...rows].sort(
        (a, b) =>
          d(nearPoint!, { lat: a.lat, lng: a.lng }) - d(nearPoint!, { lat: b.lat, lng: b.lng }),
      );
    }
    const start = offset ?? 0;
    rows = rows.slice(start, start + (limit ?? 50));
    return { hubs: await hubDtos(rows, nearPoint), total };
  });

  /** Public single-hub detail (ADR-030): same shape as one list entry. */
  app.get('/hubs/:id', { schema: { params: hubParams } }, async (request, reply) => {
    const [hub] = await app.db
      .select()
      .from(hubs)
      .where(and(eq(hubs.id, request.params.id), eq(hubs.active, true)));
    if (!hub) return reply.code(404).send({ error: 'not_found' });
    const [dto] = await hubDtos([hub], null);
    return dto;
  });

  /** Shipments waiting for a carrier at this hub (ADR-030 "reverse trip
   *  planning"): a carrier browsing the network sees what they could pick up
   *  HERE before declaring a trip. Requires a session (the shipment inventory
   *  of a hub is for participants, not for the open web) but no trip: the
   *  numbers are indicative ceilings — the frozen per-leg price still comes
   *  only from the board. */
  app.get(
    '/hubs/:id/waiting-shipments',
    { schema: { params: hubParams }, preHandler: requireAuth },
    async (request, reply) => {
      const [hub] = await app.db
        .select()
        .from(hubs)
        .where(and(eq(hubs.id, request.params.id), eq(hubs.active, true)));
      if (!hub) return reply.code(404).send({ error: 'not_found' });

      const atHub = await app.db
        .select({ shipment: shipments, stay: hubStays })
        .from(shipments)
        .innerJoin(
          hubStays,
          and(eq(hubStays.shipmentId, shipments.id), eq(hubStays.status, 'active')),
        )
        .where(and(eq(shipments.status, 'at_hub'), eq(hubStays.hubId, hub.id)));
      const ids = atHub.map((r) => r.shipment.id);

      // Same board-exclusion rules as MATCHING §3: a leg in flight (requested
      // included, ADR-029) or a live claim takes the shipment off the shelf.
      const busy = new Set<string>();
      if (ids.length > 0) {
        for (const row of await app.db
          .select({ shipmentId: legs.shipmentId })
          .from(legs)
          .where(
            and(
              inArray(legs.shipmentId, ids),
              inArray(legs.status, ['requested', 'pending_funding', 'booked', 'picked_up']),
            ),
          )) {
          busy.add(row.shipmentId);
        }
        for (const row of await app.db
          .select({ shipmentId: shipmentClaims.shipmentId })
          .from(shipmentClaims)
          .where(
            and(
              inArray(shipmentClaims.shipmentId, ids),
              inArray(shipmentClaims.status, ['pending_funding', 'funded']),
            ),
          )) {
          busy.add(row.shipmentId);
        }
      }

      const destIds = [...new Set(atHub.map((r) => r.shipment.destHubId))];
      const destRows =
        destIds.length === 0
          ? []
          : await app.db.select().from(hubs).where(inArray(hubs.id, destIds));
      const destById = new Map(destRows.map((h) => [h.id, h]));
      const d = app.lifecycle.distance.distanceKm.bind(app.lifecycle.distance);

      // ADR-031: road shipments' distances in their own metric where the
      // cache/router answers (one matrix call for the whole shelf), haversine
      // estimate otherwise. These numbers are ADVISORY ceilings — the binding
      // price still freezes on the board — so they degrade instead of hiding
      // the shipment.
      const hubPoint = { lat: hub.lat, lng: hub.lng };
      const roadDestPoints = new Map<string, { lat: number; lng: number }>();
      for (const { shipment } of atHub) {
        const dest = destById.get(shipment.destHubId);
        if (dest && shipment.distanceMetric === 'road') {
          roadDestPoints.set(pointKeyOf(dest), { lat: dest.lat, lng: dest.lng });
        }
      }
      const roadMap =
        roadDestPoints.size > 0
          ? await app.roadRouting.resolveMatrix(app.db, [hubPoint], [...roadDestPoints.values()])
          : new Map<string, number>();

      const waiting = [];
      for (const { shipment } of atHub) {
        if (busy.has(shipment.id)) continue;
        const dest = destById.get(shipment.destHubId);
        if (!dest) continue;
        const destPoint = { lat: dest.lat, lng: dest.lng };
        let remainingKm: number | null = null;
        if (shipment.distanceMetric === 'road' && hasPair(roadMap, hubPoint, destPoint)) {
          const metres = roadMap.get(pairKeyOf(hubPoint, destPoint)) ?? 0;
          remainingKm = metres / 1000;
        }
        if (remainingKm === null) remainingKm = d(hubPoint, destPoint);
        if (!(remainingKm > 0)) continue;
        const bundle = await loadShipmentBundle(app.db, shipment.id);
        if (!bundle) continue;
        // Indicative ceiling: the whole remaining work pool (what a single
        // delivering leg would gross) plus the accrued carrier bonus Π_v.
        // min(): the haversine fallback of a road shipment can exceed the
        // road-frozen D, and the pool math wants r ≤ D.
        const maxGrossMsat =
          remainingWorkPool(bundle, Math.min(remainingKm, shipment.distanceKm)) +
          bundle.carrierBonusAvailableMsat;
        waiting.push({
          shipmentId: shipment.id,
          codename: shipment.codename,
          destHubId: dest.id,
          destHubName: dest.name,
          remainingKm,
          dims: { lengthCm: shipment.dimLCm, widthCm: shipment.dimWCm, heightCm: shipment.dimHCm },
          weightG: shipment.weightG,
          undeclared: shipment.undeclared,
          custodyBondMsat: msat(shipment.custodyBondMsat),
          maxGrossMsat: msat(maxGrossMsat),
          eurRate: {
            satsPerEur: shipment.eurRateSnapshot,
            source: shipment.eurRateSource,
            at: shipment.eurRateAt.toISOString(),
          },
        });
      }
      // Most attractive first — deterministic tiebreaker on the id.
      waiting.sort((a, b) => {
        const ga = BigInt(a.maxGrossMsat);
        const gb = BigInt(b.maxGrossMsat);
        if (ga !== gb) return gb > ga ? 1 : -1;
        return a.shipmentId < b.shipmentId ? -1 : 1;
      });
      return { hubId: hub.id, shipments: waiting };
    },
  );

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
                inArray(legs.status, [...PRICED_LEG_STATUSES]),
              ),
            );
    // null = no priced adjacent leg touches this hub (distinct from a leg
    // priced at 0 msat: a 0%-fee hub earns an EXACT zero, not an estimate).
    const frozenFeeFor = (shipmentId: string): bigint | null => {
      let total: bigint | null = null;
      for (const leg of adjacentLegs) {
        if (leg.shipmentId !== shipmentId) continue;
        if (leg.toHubId === hub.id) total = (total ?? 0n) + leg.arrHubFeeMsat;
        if (leg.fromHubId === hub.id) total = (total ?? 0n) + leg.depHubFeeMsat;
      }
      return total;
    };

    // Range for a stay with no priced adjacent leg yet — an origin stay
    // before its first leg_request: r = D and the pool is the whole work
    // split of the offer.
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
          // Exact where an adjacent leg is priced (0 msat included — a
          // 0%-fee hub earns an exact zero); otherwise a range (origin stay
          // before the first leg_request).
          projectedEarning:
            frozen !== null
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
