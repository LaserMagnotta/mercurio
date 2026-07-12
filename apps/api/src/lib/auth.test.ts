import { describe, expect, it } from 'vitest';
import { createTestDb } from '@mercurio/db/test-helpers';
import { consentEvents, emailOutbox, magicLinkTokens, users } from '@mercurio/db';
import { eq } from 'drizzle-orm';
import { requestMagicLink, verifyMagicLink } from './auth';
import { AuthError } from './errors';
import { getSessionUserId } from './session';

const CONSENT = { tosVersion: '2026-01-01', privacyVersion: '2026-01-01' };

describe('magic link auth', () => {
  it('a new email creates an account, records consent and opens a session', async () => {
    const db = await createTestDb();
    const { token } = await requestMagicLink(db, 'new@example.com');

    const result = await verifyMagicLink(db, token, CONSENT);

    expect(result.email).toBe('new@example.com');
    expect(await getSessionUserId(db, result.sessionToken)).toBe(result.userId);

    const consent = await db
      .select()
      .from(consentEvents)
      .where(eq(consentEvents.userId, result.userId));
    expect(consent.map((c) => c.type).sort()).toEqual(['privacy_policy', 'tos']);
  });

  it('a new email without consent is rejected (GDPR: explicit consent required)', async () => {
    const db = await createTestDb();
    const { token } = await requestMagicLink(db, 'new2@example.com');

    await expect(verifyMagicLink(db, token)).rejects.toMatchObject({ code: 'consent_required' });
    // and no account was created as a side effect of the rejected attempt
    expect(await db.select().from(users).where(eq(users.email, 'new2@example.com'))).toHaveLength(
      0,
    );
  });

  it('an existing user does not need to re-consent', async () => {
    const db = await createTestDb();
    const [existing] = await db
      .insert(users)
      .values({ email: 'returning@example.com' })
      .returning();
    if (!existing) throw new Error('setup failed');

    const { token } = await requestMagicLink(db, 'returning@example.com');
    const result = await verifyMagicLink(db, token);

    expect(result.userId).toBe(existing.id);
  });

  it('rejects an unknown token', async () => {
    const db = await createTestDb();
    await expect(verifyMagicLink(db, 'not-a-real-token')).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('a token can only be used once', async () => {
    const db = await createTestDb();
    const { token } = await requestMagicLink(db, 'once@example.com');

    await verifyMagicLink(db, token, CONSENT);

    await expect(verifyMagicLink(db, token, CONSENT)).rejects.toMatchObject({
      code: 'token_already_used',
    });
  });

  it('rejects an expired token', async () => {
    const db = await createTestDb();
    const { token } = await requestMagicLink(db, 'expired@example.com');
    await db
      .update(magicLinkTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(magicLinkTokens.email, 'expired@example.com'));

    await expect(verifyMagicLink(db, token, CONSENT)).rejects.toMatchObject({
      code: 'token_expired',
    });
  });

  it('a deleted (anonymized) account cannot log back in', async () => {
    const db = await createTestDb();
    const [user] = await db
      .insert(users)
      .values({ email: 'gone@example.com', deletedAt: new Date() })
      .returning();
    if (!user) throw new Error('setup failed');

    const { token } = await requestMagicLink(db, 'gone@example.com');

    await expect(verifyMagicLink(db, token)).rejects.toMatchObject({ code: 'account_deleted' });
  });

  it('queues the email in the outbox (transactional outbox, ARCHITECTURE.md sec.4)', async () => {
    const db = await createTestDb();
    await requestMagicLink(db, 'outbox@example.com');

    const rows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.to, 'outbox@example.com'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.template).toBe('magic_link');
    expect(rows[0]?.status).toBe('pending');
  });

  it('rate-limits repeated requests for the same email (anti-abuse)', async () => {
    const db = await createTestDb();
    for (let i = 0; i < 5; i++) {
      await requestMagicLink(db, 'spammed@example.com');
    }
    await expect(requestMagicLink(db, 'spammed@example.com')).rejects.toThrow(AuthError);
    await expect(requestMagicLink(db, 'spammed@example.com')).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });
});
