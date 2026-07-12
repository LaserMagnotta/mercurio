import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUserId, SESSION_COOKIE } from '../lib/session';

declare module 'fastify' {
  interface FastifyRequest {
    userId: string | null;
  }
}

/** Decorates every request with `userId` (null if unauthenticated) by
 *  reading and validating the session cookie against the database. */
export default fp(async (app) => {
  app.decorateRequest('userId', null);

  app.addHook('preHandler', async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    request.userId = token ? await getSessionUserId(app.db, token) : null;
  });
});

/** Route preHandler: rejects with 401 if the request has no valid session. */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  if (!request.userId) {
    return reply.code(401).send({ error: 'unauthenticated' });
  }
}
