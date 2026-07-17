import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import {
  carrierProfiles,
  consentEvents,
  hubs,
  legs,
  photos,
  reviews,
  shipments,
  users,
} from '@mercurio/db';
import type { BlobStore } from './blob-store.js';
import { revokeAllSessions } from './session.js';

export async function activateCarrierRole(db: Db, userId: string): Promise<void> {
  await db.insert(carrierProfiles).values({ userId }).onConflictDoNothing({
    target: carrierProfiles.userId,
  });
}

export interface RolesSummary {
  carrier: boolean;
  hub: boolean;
}

export async function getRoles(db: Db, userId: string): Promise<RolesSummary> {
  const [carrier] = await db
    .select({ id: carrierProfiles.id })
    .from(carrierProfiles)
    .where(eq(carrierProfiles.userId, userId));
  const [hub] = await db.select({ id: hubs.id }).from(hubs).where(eq(hubs.userId, userId));
  return { carrier: !!carrier, hub: !!hub };
}

/**
 * Everything the platform holds about one user, as a single JSON document
 * (GDPR right to data portability, RISKS.md sec.6). Includes data where the
 * user is either the subject (their own account, hub, carrier profile) or
 * an actor (shipments sent, legs carried, reviews authored/received,
 * consent history) - not other users' unrelated data.
 */
export async function exportUserData(db: Db, userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error('exportUserData: user not found');

  const [
    ownedHubs,
    carrierProfile,
    sentShipments,
    carriedLegs,
    reviewsAuthored,
    reviewsReceived,
    consent,
    photosTaken,
  ] = await Promise.all([
    db.select().from(hubs).where(eq(hubs.userId, userId)),
    db.select().from(carrierProfiles).where(eq(carrierProfiles.userId, userId)),
    db.select().from(shipments).where(eq(shipments.senderId, userId)),
    db.select().from(legs).where(eq(legs.carrierId, userId)),
    db.select().from(reviews).where(eq(reviews.authorId, userId)),
    db.select().from(reviews).where(eq(reviews.subjectId, userId)),
    db.select().from(consentEvents).where(eq(consentEvents.userId, userId)),
    // Metadata only, on purpose: the bytes are downloadable one by one via
    // the photo endpoint with the same session (ADR-020 §4).
    db
      .select({
        shipmentId: photos.shipmentId,
        sha256: photos.sha256,
        kind: photos.kind,
        createdAt: photos.createdAt,
        purgeAfter: photos.purgeAfter,
      })
      .from(photos)
      .where(eq(photos.takenBy, userId)),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    user: { id: user.id, email: user.email, locale: user.locale, createdAt: user.createdAt },
    hubs: ownedHubs,
    carrierProfile: carrierProfile[0] ?? null,
    shipmentsSent: sentShipments,
    legsCarried: carriedLegs,
    reviewsAuthored,
    reviewsReceived,
    consentHistory: consent,
    photosTaken,
  };
}

const TERMINAL_DB_STATUSES = ['delivered', 'cancelled', 'forfeited', 'lost'] as const;

/**
 * Account deletion (GDPR, RISKS.md sec.6): anonymizes the user row and
 * revokes every session. The ledger and custody chain are append-only and
 * reference the user only by id (no PII duplicated there - checked by
 * account.test.ts), so anonymizing this one row severs all personal data
 * without breaking referential integrity or the accounting/custody history.
 * A hub the user owned is deactivated so it drops off the board.
 *
 * Photos the user took (ADR-020 §6): deleted immediately — row and blob —
 * for shipments already CLOSED; photos of shipments still in flight stay
 * until the retention purge (they are the counterparties' documentary
 * protection of an ongoing custody). Blobs are unlinked after the commit,
 * and only when no surviving row still references the same bytes.
 */
export async function deleteAccount(db: Db, userId: string, blobStore: BlobStore): Promise<void> {
  const purgeable = await db
    .select({ id: photos.id, storageKey: photos.storageKey })
    .from(photos)
    .innerJoin(shipments, eq(shipments.id, photos.shipmentId))
    .where(and(eq(photos.takenBy, userId), inArray(shipments.status, [...TERMINAL_DB_STATUSES])));

  await db.transaction(async (tx) => {
    if (purgeable.length > 0) {
      await tx.delete(photos).where(
        inArray(
          photos.id,
          purgeable.map((p) => p.id),
        ),
      );
    }
    await tx
      .update(users)
      .set({ email: `deleted-${userId}@anonymized.invalid`, deletedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.update(hubs).set({ active: false }).where(eq(hubs.userId, userId));
    await revokeAllSessions(tx, userId);
  });

  for (const key of new Set(purgeable.map((p) => p.storageKey))) {
    const [stillReferenced] = await db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.storageKey, key))
      .limit(1);
    // A crash before this unlink leaves an orphan blob: the purge worker's
    // sweep removes it within a day (ADR-020 §5).
    if (!stillReferenced) await blobStore.delete(key);
  }
}
