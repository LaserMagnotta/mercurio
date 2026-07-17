// Photo retention purge (ADR-020 §5, RISKS.md §6). Plain function wired to a
// pg-boss cron in worker.ts (ADR-011 pattern: scheduling in pg-boss, the work
// unit-testable on pglite with an injected clock and a memory blob store).
//
// Two phases plus a sweep:
//  1. tighten `purge_after` to closure + 30 days for photos of TERMINAL
//     shipments (closure = created_at of the last custody event) — the
//     column stays the single inspectable truth of when a photo dies;
//  2. delete rows whose `purge_after` has passed: row first, then the blob
//     if no surviving row still references it (content-addressed dedup);
//  3. orphan sweep: blobs on disk with no row and old enough not to be an
//     upload in flight (covers crashes between blob write and row insert,
//     and between row delete and blob unlink).

import { and, eq, gt, inArray, lt, max } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { custodyEvents, photos, shipments } from '@mercurio/db';
import { PHOTO_RETENTION_DAYS_AFTER_CLOSURE } from '@mercurio/shared';
import type { BlobStore } from '../lib/blob-store.js';

const TERMINAL_DB_STATUSES = ['delivered', 'cancelled', 'forfeited', 'lost'] as const;

/** How old a row-less blob must be before the sweep treats it as an orphan
 *  rather than an upload whose row insert is still in flight. */
const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface PhotoPurgeDeps {
  db: Db;
  blobStore: BlobStore;
  now: () => Date;
}

export interface PhotoPurgeReport {
  tightened: number;
  purgedRows: number;
  deletedBlobs: number;
  orphanBlobsDeleted: number;
}

export async function purgeExpiredPhotos(deps: PhotoPurgeDeps): Promise<PhotoPurgeReport> {
  const { db, blobStore } = deps;
  const now = deps.now();
  const report: PhotoPurgeReport = {
    tightened: 0,
    purgedRows: 0,
    deletedBlobs: 0,
    orphanBlobsDeleted: 0,
  };

  // --- phase 1: closure + 30 days for terminal shipments
  const closures = await db
    .select({
      shipmentId: photos.shipmentId,
      closedAt: max(custodyEvents.createdAt),
    })
    .from(photos)
    .innerJoin(shipments, eq(shipments.id, photos.shipmentId))
    .innerJoin(custodyEvents, eq(custodyEvents.shipmentId, photos.shipmentId))
    .where(inArray(shipments.status, [...TERMINAL_DB_STATUSES]))
    .groupBy(photos.shipmentId);
  for (const { shipmentId, closedAt } of closures) {
    if (!closedAt) continue;
    const deadline = new Date(
      closedAt.getTime() + PHOTO_RETENTION_DAYS_AFTER_CLOSURE * 24 * 60 * 60 * 1000,
    );
    const tightened = await db
      .update(photos)
      .set({ purgeAfter: deadline })
      .where(and(eq(photos.shipmentId, shipmentId), gt(photos.purgeAfter, deadline)))
      .returning({ id: photos.id });
    report.tightened += tightened.length;
  }

  // --- phase 2: rows past purge_after — row first, blob when unreferenced
  const due = await db.select().from(photos).where(lt(photos.purgeAfter, now));
  for (const row of due) {
    await db.delete(photos).where(eq(photos.id, row.id));
    const [stillReferenced] = await db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.storageKey, row.storageKey))
      .limit(1);
    if (!stillReferenced) {
      await blobStore.delete(row.storageKey);
      report.deletedBlobs += 1;
    }
    report.purgedRows += 1;
  }

  // --- phase 3: orphan sweep
  for (const entry of await blobStore.list()) {
    if (now.getTime() - entry.modifiedAt.getTime() < ORPHAN_MIN_AGE_MS) continue;
    const [referenced] = await db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.storageKey, entry.key))
      .limit(1);
    if (!referenced) {
      await blobStore.delete(entry.key);
      report.orphanBlobsDeleted += 1;
    }
  }

  return report;
}
