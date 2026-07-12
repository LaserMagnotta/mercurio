import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { consentEvents, emailOutbox, magicLinkTokens, users } from '@mercurio/db';
import { AuthError } from './errors';
import { generateToken, hashToken } from './tokens';
import { createSession } from './session';

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LINKS_PER_EMAIL_PER_HOUR = 5; // anti-abuse (RISKS.md sec.7-adjacent: email bombing)

export interface ConsentInput {
  tosVersion: string;
  privacyVersion: string;
}

/**
 * Creates a magic-link token and queues the email (outbox pattern:
 * ARCHITECTURE.md sec.4). Returns the raw token so the caller can send the
 * email - it is never persisted in plaintext and never returned over HTTP.
 */
export async function requestMagicLink(db: Db, email: string): Promise<{ token: string }> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const countRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(magicLinkTokens)
    .where(and(eq(magicLinkTokens.email, email), gte(magicLinkTokens.createdAt, oneHourAgo)));
  const count = countRows[0]?.count ?? 0;
  if (count >= MAX_LINKS_PER_EMAIL_PER_HOUR) {
    throw new AuthError('rate_limited');
  }

  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);

  await db.transaction(async (tx) => {
    await tx.insert(magicLinkTokens).values({ email, tokenHash: hash, expiresAt });
    await tx.insert(emailOutbox).values({
      to: email,
      template: 'magic_link',
      payload: { token },
      status: 'pending',
    });
  });

  return { token };
}

export interface VerifyResult {
  userId: string;
  email: string;
  sessionToken: string;
  sessionExpiresAt: Date;
}

/**
 * Verifies a magic-link token, finds or creates the user, and opens a
 * session - all in one transaction so a crash mid-way never leaves a
 * consumed token without a session, or a user without recorded consent.
 *
 * New accounts require `consent` (GDPR: explicit consent, RISKS.md sec.6);
 * existing accounts don't need it again.
 */
export async function verifyMagicLink(
  db: Db,
  token: string,
  consent?: ConsentInput,
): Promise<VerifyResult> {
  const hash = hashToken(token);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(magicLinkTokens)
      .where(eq(magicLinkTokens.tokenHash, hash));
    if (!row) throw new AuthError('invalid_token');
    if (row.consumedAt) throw new AuthError('token_already_used');
    if (row.expiresAt.getTime() < Date.now()) throw new AuthError('token_expired');

    await tx
      .update(magicLinkTokens)
      .set({ consumedAt: new Date() })
      .where(eq(magicLinkTokens.id, row.id));

    let [user] = await tx.select().from(users).where(eq(users.email, row.email));
    if (!user) {
      if (!consent) throw new AuthError('consent_required');
      [user] = await tx.insert(users).values({ email: row.email }).returning();
      if (!user) throw new Error('verifyMagicLink: user insert returned no row');
      await tx.insert(consentEvents).values([
        { userId: user.id, type: 'tos', version: consent.tosVersion },
        { userId: user.id, type: 'privacy_policy', version: consent.privacyVersion },
      ]);
    }
    if (user.deletedAt) throw new AuthError('account_deleted');

    const { token: sessionToken, expiresAt: sessionExpiresAt } = await createSession(tx, user.id);

    return { userId: user.id, email: user.email, sessionToken, sessionExpiresAt };
  });
}
