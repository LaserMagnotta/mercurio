import { describe, expect, it } from 'vitest';
import { createTestDb } from '@mercurio/db/test-helpers';
import { users } from '@mercurio/db';
import { createSession, getSessionUserId, revokeAllSessions, revokeSession } from './session.js';

async function makeUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [user] = await db.insert(users).values({ email: 'alice@example.com' }).returning();
  if (!user) throw new Error('setup failed');
  return user;
}

describe('session', () => {
  it('resolves a valid session token to its user id', async () => {
    const db = await createTestDb();
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);

    expect(await getSessionUserId(db, token)).toBe(user.id);
  });

  it('rejects an unknown token', async () => {
    const db = await createTestDb();
    expect(await getSessionUserId(db, 'not-a-real-token')).toBeNull();
  });

  it('rejects a revoked session', async () => {
    const db = await createTestDb();
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);

    await revokeSession(db, token);

    expect(await getSessionUserId(db, token)).toBeNull();
  });

  it('rejects an expired session', async () => {
    const db = await createTestDb();
    const user = await makeUser(db);
    const { token } = await createSession(db, user.id);

    // Simulate expiry directly (createSession always sets a 30-day future
    // expiry) rather than waiting: this is exactly the kind of edge case
    // that must be exercised, not just assumed correct.
    const { sessions } = await import('@mercurio/db');
    const { eq } = await import('drizzle-orm');
    const { hashToken } = await import('./tokens.js');
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.tokenHash, hashToken(token)));

    expect(await getSessionUserId(db, token)).toBeNull();
  });

  it('revokeAllSessions invalidates every session for a user, not other users', async () => {
    const db = await createTestDb();
    const alice = await makeUser(db);
    const [bob] = await db.insert(users).values({ email: 'bob@example.com' }).returning();
    if (!bob) throw new Error('setup failed');

    const aliceSession1 = await createSession(db, alice.id);
    const aliceSession2 = await createSession(db, alice.id);
    const bobSession = await createSession(db, bob.id);

    await revokeAllSessions(db, alice.id);

    expect(await getSessionUserId(db, aliceSession1.token)).toBeNull();
    expect(await getSessionUserId(db, aliceSession2.token)).toBeNull();
    expect(await getSessionUserId(db, bobSession.token)).toBe(bob.id);
  });
});
