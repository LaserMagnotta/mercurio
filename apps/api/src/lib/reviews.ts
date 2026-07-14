// Review guards and rating aggregates (CLAUDE.md "Recensioni", ADR-017).
//
// Two jobs, both read-only:
//  - effectiveParticipants(): who actually PLAYED a role in a shipment — the
//    only people who may author reviews and the only (user, role) pairs that
//    may receive one ("si recensisce solo chi ha avuto un ruolo effettivo").
//  - loadRatings(): the per-(user, role) star aggregates, computed by the
//    database at read time. Never denormalized: same principle as the ledger,
//    no stale balances (see the schema comment on `reviews`).

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { custodyEvents, hubs, hubStays, legs, reviews, shipmentClaims } from '@mercurio/db';
import type { ReviewRole } from '@mercurio/shared';

export interface EffectiveParticipant {
  userId: string;
  role: ReviewRole;
  /** Set when role = 'hub': the hub whose certified stay made the owner an
   *  effective participant (the UI pins the rating to the hub, not the id). */
  hubId: string | null;
}

/**
 * Leg statuses proving the leg was FUNDED (LEG_BOOKED reached): the carrier
 * committed a real bond, so the engagement was effective whatever happened
 * next — including 'failed' (pickup/transit timeout), which is exactly the
 * behavior reputation must be able to record (RISKS.md §1). A
 * 'pending_funding' or 'expired' leg never engaged: the acceptance dissolved
 * alone inside the funding window (ADR-017).
 */
const FUNDED_LEG_STATUSES = ['booked', 'picked_up', 'completed', 'returned', 'failed'] as const;

/**
 * The effective participants of one shipment (ADR-017):
 *  - the sender, always;
 *  - the carrier of every funded leg;
 *  - the owner of every hub with a certified check-in (the hub actually
 *    hosted the parcel — a reserved stay that never checked in did not);
 *  - a claimant whose claim reached CLAIMED, as 'carrier' (ADR-016: the
 *    claim IS the residual leg, done by the recipient). A claim that only
 *    pended mirrors an unfunded leg and does not count.
 */
export async function effectiveParticipants(
  db: Db,
  shipment: { id: string; senderId: string },
): Promise<EffectiveParticipant[]> {
  const [legRows, stayRows, claimRows, fundedEvents] = await Promise.all([
    db
      .select({ carrierId: legs.carrierId })
      .from(legs)
      .where(and(eq(legs.shipmentId, shipment.id), inArray(legs.status, [...FUNDED_LEG_STATUSES]))),
    db
      .select({ hubId: hubStays.hubId, ownerId: hubs.userId })
      .from(hubStays)
      .innerJoin(hubs, eq(hubs.id, hubStays.hubId))
      .where(and(eq(hubStays.shipmentId, shipment.id), sql`${hubStays.checkedInAt} is not null`)),
    db
      .select({ id: shipmentClaims.id, claimantId: shipmentClaims.claimantId, status: shipmentClaims.status })
      .from(shipmentClaims)
      .where(eq(shipmentClaims.shipmentId, shipment.id)),
    // A claim forfeited by storage_expiry ends 'expired' like a never-funded
    // one; the custody chain's 'funded' event (payload.claimId, ADR-016
    // precisazione 4) is what proves it reached CLAIMED.
    db
      .select({ payload: custodyEvents.payload })
      .from(custodyEvents)
      .where(and(eq(custodyEvents.shipmentId, shipment.id), eq(custodyEvents.type, 'funded'))),
  ]);

  const fundedClaimIds = new Set(
    fundedEvents
      .map((row) => (row.payload as { claimId?: unknown }).claimId)
      .filter((id): id is string => typeof id === 'string'),
  );

  const byKey = new Map<string, EffectiveParticipant>();
  const add = (participant: EffectiveParticipant) => {
    byKey.set(`${participant.userId}:${participant.role}`, participant);
  };
  add({ userId: shipment.senderId, role: 'sender', hubId: null });
  for (const leg of legRows) add({ userId: leg.carrierId, role: 'carrier', hubId: null });
  for (const stay of stayRows) add({ userId: stay.ownerId, role: 'hub', hubId: stay.hubId });
  for (const claim of claimRows) {
    if (claim.status === 'funded' || claim.status === 'completed' || fundedClaimIds.has(claim.id)) {
      add({ userId: claim.claimantId, role: 'carrier', hubId: null });
    }
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Rating aggregates

export interface RoleRating {
  /** Rounded to 2 decimals for a stable API surface; null until reviewed. */
  averageStars: number | null;
  reviewCount: number;
}

export interface RatingSubject {
  userId: string;
  role: ReviewRole;
}

const EMPTY_RATING: RoleRating = { averageStars: null, reviewCount: 0 };

const key = (userId: string, role: ReviewRole): string => `${userId}:${role}`;

/**
 * One grouped query for every (user, role) aggregate the caller is about to
 * display. The map answers ratingOf() for any pair — missing pairs read as
 * "no reviews yet", so callers never special-case new users.
 */
export async function loadRatings(
  db: Db,
  subjects: readonly RatingSubject[],
): Promise<Map<string, RoleRating>> {
  const map = new Map<string, RoleRating>();
  const ids = [...new Set(subjects.map((s) => s.userId))];
  if (ids.length === 0) return map;
  const rows = await db
    .select({
      subjectId: reviews.subjectId,
      role: reviews.role,
      averageStars: sql<string>`avg(${reviews.stars})`,
      reviewCount: sql<number>`count(*)::int`,
    })
    .from(reviews)
    .where(inArray(reviews.subjectId, ids))
    .groupBy(reviews.subjectId, reviews.role);
  for (const row of rows) {
    map.set(key(row.subjectId, row.role), {
      averageStars: Math.round(Number(row.averageStars) * 100) / 100,
      reviewCount: Number(row.reviewCount),
    });
  }
  return map;
}

export function ratingOf(
  ratings: ReadonlyMap<string, RoleRating>,
  userId: string,
  role: ReviewRole,
): RoleRating {
  return ratings.get(key(userId, role)) ?? EMPTY_RATING;
}
