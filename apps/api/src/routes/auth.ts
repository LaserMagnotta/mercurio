import { z } from 'zod';
import type { App } from '../app';
import { requestMagicLink, verifyMagicLink } from '../lib/auth';
import { AuthError } from '../lib/errors';
import { revokeSession, SESSION_COOKIE } from '../lib/session';

const AUTH_ERROR_STATUS: Record<AuthError['code'], number> = {
  invalid_token: 400,
  token_expired: 400,
  token_already_used: 400,
  consent_required: 428, // Precondition Required: client must resubmit with consent
  account_deleted: 403,
  rate_limited: 429,
};

const requestLinkBody = z.object({ email: z.string().email() });

const verifyBody = z.object({
  token: z.string().min(1),
  consent: z
    .object({
      tosVersion: z.string().min(1),
      privacyVersion: z.string().min(1),
    })
    .optional(),
});

export function registerAuthRoutes(app: App) {
  app.post(
    '/auth/request-link',
    {
      schema: { body: requestLinkBody },
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { email } = request.body;
      try {
        const { token } = await requestMagicLink(app.db, email);
        const link = `${process.env.WEB_URL ?? 'http://localhost:3000'}/auth/verify?token=${token}`;
        // Fire-and-forget: the outbox row is the source of truth (ARCHITECTURE.md
        // sec.4); the HTTP response never waits on SMTP latency/availability.
        void app
          .sendMail({ to: email, subject: 'Il tuo link di accesso a Mercurio', text: link })
          .catch((err) => app.log.error({ err }, 'failed to send magic link email'));
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(AUTH_ERROR_STATUS[err.code]).send({ error: err.code });
        }
        throw err;
      }
      // Always the same response, whether or not the address has an account
      // yet (first login = signup) - nothing to leak either way.
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    '/auth/verify',
    { schema: { body: verifyBody }, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token, consent } = request.body;
      try {
        const result = await verifyMagicLink(app.db, token, consent);
        reply.setCookie(SESSION_COOKIE, result.sessionToken, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: 'lax',
          path: '/',
          expires: result.sessionExpiresAt,
        });
        return { user: { id: result.userId, email: result.email } };
      } catch (err) {
        if (err instanceof AuthError) {
          return reply.code(AUTH_ERROR_STATUS[err.code]).send({ error: err.code });
        }
        throw err;
      }
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(app.db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
