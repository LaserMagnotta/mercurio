import { eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { sessions } from '@mercurio/db';
import { generateToken, hashToken } from './tokens';

export const SESSION_COOKIE = 'mercurio_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(db: Db, userId: string) {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: hash, expiresAt, method: 'magic_link' });
  return { token, expiresAt };
}

/** Returns the authenticated user id, or null if the token is missing/expired/revoked. */
export async function getSessionUserId(db: Db, token: string): Promise<string | null> {
  const hash = hashToken(token);
  const [session] = await db.select().from(sessions).where(eq(sessions.tokenHash, hash));
  if (!session) return null;
  if (session.revokedAt) return null;
  if (session.expiresAt.getTime() < Date.now()) return null;
  return session.userId;
}

export async function revokeSession(db: Db, token: string): Promise<void> {
  const hash = hashToken(token);
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.tokenHash, hash));
}

/** Revokes every active session for a user (used on account deletion). */
export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId));
}
