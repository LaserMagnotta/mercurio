import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, type Db } from '@mercurio/db';
import authGuard from './plugins/auth-guard';
import { registerAuthRoutes } from './routes/auth';
import { registerMeRoutes } from './routes/me';
import { createMailer, type SendMail } from './lib/mailer';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    sendMail: SendMail;
  }
}

export interface BuildAppOptions {
  db?: Db;
  sendMail?: SendMail;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.decorate('db', options.db ?? createDb());
  app.decorate('sendMail', options.sendMail ?? createMailer());

  void app.register(cookie);
  // Global default; individual routes (magic-link request/verify) set
  // tighter limits via route config (RISKS.md sec.7: anti-abuse).
  void app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  void app.register(authGuard);

  app.get('/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app);
  registerMeRoutes(app);

  return app;
}

/** The app type, with the Zod type provider and our decorations - route
 *  files import this instead of the bare `FastifyInstance` so that Zod
 *  schemas passed to `{ schema: { body } }` are actually inferred. */
export type App = ReturnType<typeof buildApp>;
