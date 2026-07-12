import { eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import {
  carrierProfiles,
  consentEvents,
  hubs,
  legs,
  reviews,
  shipments,
  users,
} from '@mercurio/db';
import { revokeAllSessions } from './session';

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
  ] = await Promise.all([
    db.select().from(hubs).where(eq(hubs.userId, userId)),
    db.select().from(carrierProfiles).where(eq(carrierProfiles.userId, userId)),
    db.select().from(shipments).where(eq(shipments.senderId, userId)),
    db.select().from(legs).where(eq(legs.carrierId, userId)),
    db.select().from(reviews).where(eq(reviews.authorId, userId)),
    db.select().from(reviews).where(eq(reviews.subjectId, userId)),
    db.select().from(consentEvents).where(eq(consentEvents.userId, userId)),
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
  };
}

/**
 * Account deletion (GDPR, RISKS.md sec.6): anonymizes the user row and
 * revokes every session. The ledger and custody chain are append-only and
 * reference the user only by id (no PII duplicated there - checked by
 * account.test.ts), so anonymizing this one row severs all personal data
 * without breaking referential integrity or the accounting/custody history.
 * A hub the user owned is deactivated so it drops off the board.
 */
export async function deleteAccount(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ email: `deleted-${userId}@anonymized.invalid`, deletedAt: new Date() })
      .where(eq(users.id, userId));
    await tx.update(hubs).set({ active: false }).where(eq(hubs.userId, userId));
    await revokeAllSessions(tx, userId);
  });
}
