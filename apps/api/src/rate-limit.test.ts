// Anti-abuse rate limiting (RISKS §7) and how it survives the production
// reverse proxy (ADR-024).
//
// Every assertion here uses a DIFFERENT email per request on purpose: the
// magic-link route also carries a per-email throttle in the database
// (MAX_LINKS_PER_EMAIL_PER_HOUR, lib/auth.ts), which would answer 429 on its
// own and mask whether the IP limiter works at all.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@mercurio/db/test-helpers';
import { buildApp } from './app.js';

/** The magic-link route's own limit: 5 per 15 minutes (routes/auth.ts). */
const REQUEST_LINK_MAX = 5;

async function buildAppWith(trustProxy: boolean) {
  const app = await buildApp({
    db: await createTestDb(),
    sendMail: async () => {},
    coordinatorKey: randomBytes(32),
    trustProxy,
  });
  await app.ready();
  return app;
}

let uniqueEmail = 0;
const requestLink = (app: Awaited<ReturnType<typeof buildAppWith>>, client: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/request-link',
    headers: { 'x-forwarded-for': client },
    payload: { email: `sender${uniqueEmail++}@example.com` },
  });

describe('rate limiting (RISKS §7)', () => {
  // Regression: @fastify/rate-limit attaches the per-route limits through an
  // onRoute hook, so registering it without awaiting leaves every limit in
  // the API inert while looking configured.
  it('actually applies a route limit to repeated calls from one client', async () => {
    const app = await buildAppWith(true);

    for (let i = 0; i < REQUEST_LINK_MAX; i++) {
      expect((await requestLink(app, '1.1.1.1')).statusCode).toBe(202);
    }
    expect((await requestLink(app, '1.1.1.1')).statusCode).toBe(429);
  });

  describe('behind the production reverse proxy (ADR-024)', () => {
    it('with TRUST_PROXY, each forwarded client gets its own bucket', async () => {
      const app = await buildAppWith(true);

      for (let i = 0; i < REQUEST_LINK_MAX; i++) {
        expect((await requestLink(app, '1.1.1.1')).statusCode).toBe(202);
      }
      // The abuser has spent their own quota...
      expect((await requestLink(app, '1.1.1.1')).statusCode).toBe(429);
      // ...and nobody else's: a different client is still served.
      expect((await requestLink(app, '2.2.2.2')).statusCode).toBe(202);
    });

    it('without it, one client exhausting the quota locks out every other', async () => {
      const app = await buildAppWith(false);

      for (let i = 0; i < REQUEST_LINK_MAX; i++) {
        expect((await requestLink(app, '1.1.1.1')).statusCode).toBe(202);
      }
      // X-Forwarded-For ignored, so both clients are the same socket address:
      // this is the outage TRUST_PROXY=true prevents when a proxy fronts the
      // API. It stays off by default because a header nothing overwrites is
      // forgeable, and that fails the same control open instead of shut.
      expect((await requestLink(app, '2.2.2.2')).statusCode).toBe(429);
    });
  });
});
