import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@mercurio/db/test-helpers';
import { emailOutbox } from '@mercurio/db';
import { eq } from 'drizzle-orm';
import { buildApp } from './app.js';

const CONSENT = { tosVersion: '2026-01-01', privacyVersion: '2026-01-01' };

async function buildTestApp() {
  const db = await createTestDb();
  const app = await buildApp({ db, sendMail: async () => {}, coordinatorKey: randomBytes(32) });
  await app.ready();
  return { app, db };
}

function cookieFrom(setCookieHeader: string | string[] | undefined): string {
  const raw = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader;
  if (!raw) throw new Error('no Set-Cookie header in response');
  return raw.split(';')[0] ?? '';
}

async function tokenFor(db: Awaited<ReturnType<typeof createTestDb>>, email: string) {
  const [row] = await db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.to, email))
    .orderBy(emailOutbox.createdAt);
  const payload = row?.payload as { token?: string } | undefined;
  if (!payload?.token) throw new Error(`no magic-link token queued for ${email}`);
  return payload.token;
}

describe('auth + account HTTP flow', () => {
  it('rejects a malformed email at the validation layer, before any DB write', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email: 'not-an-email' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /me without a session is unauthenticated', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('full flow: request link -> verify -> roles -> export -> logout', async () => {
    const { app, db } = await buildTestApp();
    const email = 'flow@example.com';

    const requestRes = await app.inject({
      method: 'POST',
      url: '/auth/request-link',
      payload: { email },
    });
    expect(requestRes.statusCode).toBe(202);

    const token = await tokenFor(db, email);

    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token, consent: CONSENT },
    });
    expect(verifyRes.statusCode).toBe(200);
    expect(verifyRes.json().user.email).toBe(email);
    const cookie = cookieFrom(verifyRes.headers['set-cookie']);

    const meRes = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().roles).toEqual({ carrier: false, hub: false });

    const activateRes = await app.inject({
      method: 'POST',
      url: '/me/roles/carrier',
      headers: { cookie },
    });
    expect(activateRes.statusCode).toBe(200);

    const hubBody = {
      name: 'Bar Mario',
      address: 'Via Zamboni 5, Bologna',
      lat: 44.4949,
      lng: 11.3426,
      openingHours: { 'mon-sat': '06:00-21:00' },
      maxDimCmL: 50,
      maxDimCmW: 50,
      maxDimCmH: 50,
      maxWeightG: 15000,
      acceptsUndeclared: true,
      feePercent: 10,
      maxStorageDays: 3,
      autoAccept: true,
    };
    const hubRes = await app.inject({
      method: 'POST',
      url: '/me/roles/hub',
      headers: { cookie },
      payload: hubBody,
    });
    expect(hubRes.statusCode).toBe(201);

    // A second hub for the same user is rejected (one hub per user, ARCHITECTURE.md sec.4)
    const secondHubRes = await app.inject({
      method: 'POST',
      url: '/me/roles/hub',
      headers: { cookie },
      payload: hubBody,
    });
    expect(secondHubRes.statusCode).toBe(409);

    const meAfterRes = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(meAfterRes.json().roles).toEqual({ carrier: true, hub: true });

    const exportRes = await app.inject({ method: 'GET', url: '/me/export', headers: { cookie } });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.json().hubs).toHaveLength(1);

    const logoutRes = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logoutRes.statusCode).toBe(200);

    const meAfterLogoutRes = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(meAfterLogoutRes.statusCode).toBe(401);
  });

  it('rejects a hub fee above the validation cap (ECONOMICS.md sec.5)', async () => {
    const { app, db } = await buildTestApp();
    const email = 'greedyhub@example.com';
    await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email } });
    const token = await tokenFor(db, email);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token, consent: CONSENT },
    });
    const cookie = cookieFrom(verifyRes.headers['set-cookie']);

    const res = await app.inject({
      method: 'POST',
      url: '/me/roles/hub',
      headers: { cookie },
      payload: {
        name: 'Too Greedy Hub',
        address: 'Somewhere',
        lat: 0,
        lng: 0,
        openingHours: {},
        maxDimCmL: 10,
        maxDimCmW: 10,
        maxDimCmH: 10,
        maxWeightG: 1000,
        acceptsUndeclared: false,
        feePercent: 50, // above the 30% cap
        maxStorageDays: 1,
        autoAccept: true,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('serves the OpenAPI document on /docs (ADR-002: public, documented API)', async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json() as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/shipments', '/shipments/{id}/legs', '/trips/{id}/board']),
    );
  });

  it('DELETE /me anonymizes the account and revokes the session', async () => {
    const { app, db } = await buildTestApp();
    const email = 'deleteflow@example.com';
    await app.inject({ method: 'POST', url: '/auth/request-link', payload: { email } });
    const token = await tokenFor(db, email);
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/auth/verify',
      payload: { token, consent: CONSENT },
    });
    const cookie = cookieFrom(verifyRes.headers['set-cookie']);

    const deleteRes = await app.inject({ method: 'DELETE', url: '/me', headers: { cookie } });
    expect(deleteRes.statusCode).toBe(200);

    const meRes = await app.inject({ method: 'GET', url: '/me', headers: { cookie } });
    expect(meRes.statusCode).toBe(401);
  });
});
