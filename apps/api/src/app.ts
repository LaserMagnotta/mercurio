import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createDb, type Db } from '@mercurio/db';
import { createHaversineDistanceProvider, type DistanceProvider } from '@mercurio/core';
import {
  loadCoordinatorKey,
  PreimageCoordinator,
  type EscrowCoordinator,
  type FakeLightningNetwork,
  type WalletResolver,
} from '@mercurio/escrow';
import authGuard from './plugins/auth-guard';
import { registerAuthRoutes } from './routes/auth';
import { registerMeRoutes } from './routes/me';
import { registerWalletRoutes } from './routes/wallet';
import { registerHubRoutes } from './routes/hubs';
import { registerTripRoutes } from './routes/trips';
import { registerShipmentRoutes } from './routes/shipments';
import { registerShipmentLifecycleRoutes } from './routes/shipment-lifecycle';
import { registerReviewRoutes } from './routes/reviews';
import { createMailer, type SendMail } from './lib/mailer';
import { createDbWalletResolver } from './lib/wallets';
import { createEnvEurRateProvider, type EurRateProvider } from './lib/eur-rate';
import type { LifecycleDeps } from './shipments/executor';

/** Non-injectable knobs the routes need beyond LifecycleDeps. */
export interface LifecycleConfig {
  secretKey: Buffer;
  fakeWalletsEnabled: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    sendMail: SendMail;
    lifecycle: LifecycleDeps;
    lifecycleConfig: LifecycleConfig;
    eurRate: EurRateProvider;
  }
}

export interface BuildAppOptions {
  db?: Db;
  sendMail?: SendMail;
  /** Injected by tests; defaults to the DB-backed non-custodial stack. */
  coordinator?: EscrowCoordinator;
  walletResolver?: WalletResolver;
  distanceProvider?: DistanceProvider;
  eurRate?: EurRateProvider;
  now?: () => Date;
  /** 32-byte key (COORDINATOR_KEY) for preimages and wallet secrets. */
  coordinatorKey?: Buffer;
  /** Enables `kind: 'fake'` wallet connections (dev/test only). */
  fakeNetwork?: FakeLightningNetwork;
  /** Sync-hold / instant-settlement polling knobs (tests tighten them). */
  waitAttempts?: number;
  waitDelayMs?: number;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const db = options.db ?? createDb();
  const now = options.now ?? (() => new Date());
  const coordinatorKey = options.coordinatorKey ?? loadCoordinatorKey();
  const walletResolver =
    options.walletResolver ??
    createDbWalletResolver(db, {
      key: coordinatorKey,
      ...(options.fakeNetwork && { fakeNetwork: options.fakeNetwork }),
    });
  const coordinator =
    options.coordinator ??
    new PreimageCoordinator({
      db,
      resolveWallet: walletResolver,
      coordinatorKey,
      now: () => now().getTime(),
    });
  const lifecycle: LifecycleDeps = {
    db,
    coordinator,
    resolveWallet: walletResolver,
    distance: options.distanceProvider ?? createHaversineDistanceProvider(),
    now,
    ...(options.waitAttempts !== undefined && { waitAttempts: options.waitAttempts }),
    ...(options.waitDelayMs !== undefined && { waitDelayMs: options.waitDelayMs }),
  };

  app.decorate('db', db);
  app.decorate('sendMail', options.sendMail ?? createMailer());
  app.decorate('lifecycle', lifecycle);
  app.decorate('lifecycleConfig', {
    secretKey: coordinatorKey,
    fakeWalletsEnabled: options.fakeNetwork !== undefined,
  });
  app.decorate('eurRate', options.eurRate ?? createEnvEurRateProvider());

  // Public API contract (ADR-002): OpenAPI generated from the same Zod
  // schemas the routes validate with, served at /docs. Awaited on purpose:
  // @fastify/swagger collects routes through an onRoute hook, which must be
  // attached BEFORE the route functions below run.
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Mercurio API',
        description:
          'Peer-to-peer logistics with non-custodial Lightning payments. ' +
          'All msat amounts are decimal strings; the platform never holds funds (ADR-013).',
        version: '0.1.0',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  void app.register(cookie);
  // Global default; individual routes (magic-link request/verify, OTP pickup)
  // set tighter limits via route config (RISKS.md sec.7: anti-abuse).
  void app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  void app.register(authGuard);

  app.get('/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app);
  registerMeRoutes(app);
  registerWalletRoutes(app);
  registerHubRoutes(app);
  registerTripRoutes(app);
  registerShipmentRoutes(app);
  registerShipmentLifecycleRoutes(app);
  registerReviewRoutes(app);

  return app;
}

/** The app type, with the Zod type provider and our decorations - route
 *  files import this instead of the bare `FastifyInstance` so that Zod
 *  schemas passed to `{ schema: { body } }` are actually inferred. */
export type App = Awaited<ReturnType<typeof buildApp>>;
