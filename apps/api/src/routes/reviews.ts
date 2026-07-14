// Reviews (CLAUDE.md "Recensioni", ADR-017): per-role 5-star judgments
// between the effective participants of a CLOSED shipment.
//
// Reviews move no money — they never touch the ledger or the escrow — but
// they weigh on reputation, so every guard is explicit and separately
// tested: closed shipment, review window, author is a participant, no
// self-review, subject actually held the claimed role, one review per
// (shipment, author, subject, role) — the last one enforced by the DB's
// unique constraint, not by a read-then-write race.

import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { reviews, users } from '@mercurio/db';
import { isTerminalState } from '@mercurio/core';
import { createReviewBody, REVIEW_WINDOW_DAYS } from '@mercurio/shared';
import type { App } from '../app';
import { requireAuth } from '../plugins/auth-guard';
import { effectiveParticipants, loadRatings, ratingOf } from '../lib/reviews';
import { loadShipmentBundle } from '../shipments/context';

const shipmentParams = z.object({ id: z.string().uuid() });
const userParams = z.object({ id: z.string().uuid() });

function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { code?: string }).code ?? (err as { cause?: { code?: string } }).cause?.code;
  return code === '23505';
}

export function registerReviewRoutes(app: App) {
  app.post(
    '/shipments/:id/reviews',
    { schema: { params: shipmentParams, body: createReviewBody }, preHandler: requireAuth },
    async (request, reply) => {
      const bundle = await loadShipmentBundle(app.db, request.params.id);
      if (!bundle) return reply.code(404).send({ error: 'not_found' });

      // Closed shipment only (ADR-017): ALL terminal states, not just
      // DELIVERED — with no arbiter, reputation is the only sanction and the
      // bad endings are exactly where it matters (RISKS.md §1).
      if (!isTerminalState(bundle.state)) {
        return reply.code(409).send({ error: 'shipment_not_closed' });
      }
      // The closing custody event dates the closure; a terminal shipment
      // always has one (every transition appends exactly one event).
      const closedAt = bundle.chain.at(-1)!.createdAt;
      const now = app.lifecycle.now();
      if (now.getTime() > closedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
        return reply.code(409).send({ error: 'review_window_closed' });
      }

      const authorId = request.userId!;
      const participants = await effectiveParticipants(app.db, {
        id: bundle.shipment.id,
        senderId: bundle.shipment.senderId,
      });
      if (!participants.some((p) => p.userId === authorId)) {
        return reply.code(403).send({ error: 'not_a_participant' });
      }
      const { subjectId, role, stars, comment } = request.body;
      if (subjectId === authorId) {
        return reply.code(422).send({ error: 'self_review' });
      }
      if (!participants.some((p) => p.userId === subjectId && p.role === role)) {
        return reply.code(422).send({ error: 'subject_role_not_effective' });
      }

      try {
        const [row] = await app.db
          .insert(reviews)
          .values({
            shipmentId: bundle.shipment.id,
            authorId,
            subjectId,
            role,
            stars,
            comment: comment ?? null,
            createdAt: now,
          })
          .returning();
        return reply.code(201).send({
          id: row!.id,
          shipmentId: row!.shipmentId,
          authorId: row!.authorId,
          subjectId: row!.subjectId,
          role: row!.role,
          stars: row!.stars,
          comment: row!.comment,
          createdAt: row!.createdAt.toISOString(),
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          return reply.code(409).send({ error: 'already_reviewed' });
        }
        throw err;
      }
    },
  );

  /** Received reviews + per-role aggregates (the future profile page).
   *  Public: ratings are "visibili ovunque si scelga una controparte". */
  app.get('/users/:id/reviews', { schema: { params: userParams } }, async (request, reply) => {
    const userId = request.params.id;
    const [user] = await app.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return reply.code(404).send({ error: 'not_found' });

    const [ratings, received] = await Promise.all([
      loadRatings(app.db, [
        { userId, role: 'sender' },
        { userId, role: 'carrier' },
        { userId, role: 'hub' },
      ]),
      app.db
        .select()
        .from(reviews)
        .where(eq(reviews.subjectId, userId))
        .orderBy(desc(reviews.createdAt)),
    ]);
    return {
      userId,
      ratings: {
        sender: ratingOf(ratings, userId, 'sender'),
        carrier: ratingOf(ratings, userId, 'carrier'),
        hub: ratingOf(ratings, userId, 'hub'),
      },
      reviews: received.map((r) => ({
        id: r.id,
        shipmentId: r.shipmentId,
        authorId: r.authorId,
        subjectId: r.subjectId,
        role: r.role,
        stars: r.stars,
        comment: r.comment,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}
