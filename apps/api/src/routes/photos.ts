// Photo blob endpoints (ADR-020). The custody chain stays the only source of
// certification: an upload is accepted ONLY for a sha256 already declared in
// the shipment's certification record (chain payloads — the genesis `created`
// event included, ADR-022 — or the active leg's pending checkout
// confirmation), by the user who declared it, and only when the received
// bytes hash to exactly that value. Download is session-authz'd per request —
// never public or signed URLs (ADR-020 §4).

import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '@mercurio/db';
import { legs, photos } from '@mercurio/db';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_RETENTION_DAYS,
  sha256String,
  type PhotoKind,
} from '@mercurio/shared';
import type { App } from '../app.js';
import { requireAuth } from '../plugins/auth-guard.js';
import { sha256Hex } from '../lib/blob-store.js';
import { isJpeg, jpegHasGpsExif } from '../lib/photo-validation.js';
import { loadShipmentBundle, type ShipmentBundle } from '../shipments/context.js';
import { isShipmentParticipant } from '../shipments/participants.js';

const shipmentParams = z.object({ id: z.string().uuid() });
const photoParams = z.object({ id: z.string().uuid(), sha256: sha256String });

/** Where (and by whom) a declared hash was certified (ADR-020 §3). */
interface PhotoCertification {
  kind: PhotoKind;
  custodyEventId: string | null;
  photographerId: string;
}

/**
 * Finds the declared hash in the shipment's certification record. Almost
 * every event's photographer is its actor; `hub_checkout` is the exception —
 * the event's actor is the CARRIER taking custody, but the photos were
 * declared by the departure hub with its confirmation (ARCHITECTURE.md §7).
 * A hub-confirmed checkout whose double confirmation is still pending has no
 * custody event yet: its hashes live on the leg row and link to no event.
 * The genesis `created` event carries the sender's creation photos under two
 * kind-specific keys (ADR-022) — one event, two kinds.
 */
async function findCertification(
  db: Db,
  bundle: ShipmentBundle,
  sha256: string,
): Promise<PhotoCertification | null> {
  for (const event of bundle.chain) {
    if (event.type === 'created') {
      const payload = event.payload as {
        contentPhotoSha256?: unknown;
        sealedPhotoSha256?: unknown;
      };
      // Same hash in both lists: first match wins — the kind is display
      // metadata, authz and retention do not depend on it (ADR-022 §2).
      for (const [key, kind] of [
        ['contentPhotoSha256', 'content'],
        ['sealedPhotoSha256', 'sealed'],
      ] as const) {
        const declared = Array.isArray(payload[key]) ? (payload[key] as unknown[]) : [];
        if (declared.includes(sha256) && event.actorUserId) {
          return { kind, custodyEventId: event.id, photographerId: event.actorUserId };
        }
      }
      continue;
    }
    const payload = event.payload as { photoSha256?: unknown };
    const declared = Array.isArray(payload.photoSha256) ? payload.photoSha256 : [];
    if (!declared.includes(sha256)) continue;
    switch (event.type) {
      case 'hub_checkin':
      case 'hub_checkin_intermediate':
      case 'arrived_destination':
      case 'leg_returned':
        if (!event.actorUserId) return null;
        return { kind: 'checkin', custodyEventId: event.id, photographerId: event.actorUserId };
      case 'hub_checkout': {
        if (!event.legId) return null;
        const [legRow] = await db.select().from(legs).where(eq(legs.id, event.legId));
        const fromHub = legRow ? bundle.hubById.get(legRow.fromHubId) : undefined;
        if (!fromHub) return null;
        return { kind: 'checkout', custodyEventId: event.id, photographerId: fromHub.userId };
      }
      case 'handoff_rejected':
        if (!event.actorUserId) return null;
        return { kind: 'evidence', custodyEventId: event.id, photographerId: event.actorUserId };
      default:
        continue; // hashes on any other event type are not a certification
    }
  }
  const legRow = bundle.activeLegRow;
  const pending = (legRow?.checkoutPhotoSha256 as string[] | null) ?? [];
  if (legRow && pending.includes(sha256)) {
    const fromHub = bundle.hubById.get(legRow.fromHubId);
    if (fromHub) return { kind: 'checkout', custodyEventId: null, photographerId: fromHub.userId };
  }
  return null;
}

const daysFromNow = (now: Date, days: number) =>
  new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

export function registerPhotoRoutes(app: App) {
  /** 404 for missing shipments AND for non-participants: same behavior as
   *  GET /shipments/:id — a photo URL must never confirm a shipment exists. */
  async function loadForParticipant(
    shipmentId: string,
    userId: string,
  ): Promise<ShipmentBundle | null> {
    const bundle = await loadShipmentBundle(app.db, shipmentId);
    if (!bundle) return null;
    return (await isShipmentParticipant(app.db, bundle, userId)) ? bundle : null;
  }

  app.post(
    '/shipments/:id/photos/:sha256',
    {
      schema: {
        params: photoParams,
        // The public contract third-party clients must honor (ADR-020 §2,
        // ADR-022 §6): the server verifies, it never re-encodes.
        description:
          'Uploads the bytes of an ALREADY CERTIFIED photo (raw image/jpeg body). ' +
          'The :sha256 must have been declared beforehand — in a custody-event ' +
          'payload, in the pending checkout confirmation, or in the creation ' +
          'photo fields of POST /shipments — by the caller, and the bytes must ' +
          'hash to exactly that value. Clients MUST strip EXIF metadata ' +
          '(re-encode) on the device BEFORE hashing: the server refuses JPEGs ' +
          'carrying a GPS EXIF block (photo_exif_gps) and never rewrites bytes.',
      },
      preHandler: requireAuth,
      bodyLimit: PHOTO_MAX_BYTES,
    },
    async (request, reply) => {
      const { id, sha256 } = request.params;
      const userId = request.userId!;
      const bundle = await loadForParticipant(id, userId);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });

      const certification = await findCertification(app.db, bundle, sha256);
      if (!certification) return reply.code(422).send({ error: 'photo_not_certified' });
      if (certification.photographerId !== userId) {
        return reply.code(403).send({ error: 'photo_not_photographer' });
      }

      const bytes = request.body as Buffer;
      if (!Buffer.isBuffer(bytes) || !isJpeg(bytes)) {
        return reply.code(422).send({ error: 'photo_format_unsupported' });
      }
      // The declared hash is the anchor: the server verifies, never replaces
      // (ARCHITECTURE.md §5 precisazione 12).
      if (sha256Hex(bytes) !== sha256) {
        return reply.code(422).send({ error: 'photo_hash_mismatch' });
      }
      // Defense in depth: the first-party client strips EXIF on device
      // BEFORE hashing (ADR-020 §2); geotagged bytes only ever arrive from
      // third-party clients or bugs, and are refused rather than re-encoded.
      if (jpegHasGpsExif(bytes)) {
        return reply.code(422).send({ error: 'photo_exif_gps' });
      }

      const [existing] = await app.db
        .select({ id: photos.id, kind: photos.kind })
        .from(photos)
        .where(and(eq(photos.shipmentId, id), eq(photos.sha256, sha256)));
      if (existing) {
        return { sha256, kind: existing.kind, duplicated: true };
      }

      // Blob first, row second: a crash in between leaves an orphan blob the
      // purge worker's sweep removes (ADR-020 §5) — never a row whose bytes
      // were lost.
      await app.blobStore.put(sha256, bytes);
      await app.db.insert(photos).values({
        shipmentId: id,
        custodyEventId: certification.custodyEventId,
        kind: certification.kind,
        storageKey: sha256,
        sha256,
        takenBy: userId,
        purgeAfter: daysFromNow(app.lifecycle.now(), PHOTO_MAX_RETENTION_DAYS),
      });
      return reply.code(201).send({ sha256, kind: certification.kind, duplicated: false });
    },
  );

  app.get(
    '/shipments/:id/photos',
    { schema: { params: shipmentParams }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadForParticipant(request.params.id, request.userId!);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });
      const rows = await app.db
        .select()
        .from(photos)
        .where(eq(photos.shipmentId, request.params.id))
        .orderBy(asc(photos.createdAt));
      return {
        photos: rows.map((p) => ({
          sha256: p.sha256,
          kind: p.kind,
          custodyEventId: p.custodyEventId,
          takenBy: p.takenBy,
          createdAt: p.createdAt.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/shipments/:id/photos/:sha256',
    { schema: { params: photoParams }, preHandler: requireAuth },
    async (request, reply) => {
      const { id, sha256 } = request.params;
      const bundle = await loadForParticipant(id, request.userId!);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });
      const [row] = await app.db
        .select({ storageKey: photos.storageKey })
        .from(photos)
        .where(and(eq(photos.shipmentId, id), eq(photos.sha256, sha256)));
      const bytes = row ? await app.blobStore.get(row.storageKey) : null;
      if (!bytes) return reply.code(404).send({ error: 'not_found' });
      // Private: the authz lives in the session, the response must not land
      // in any shared cache (ADR-020 §4).
      return reply
        .header('content-type', 'image/jpeg')
        .header('cache-control', 'private, max-age=300')
        .send(bytes);
    },
  );
}
