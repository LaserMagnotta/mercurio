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
  type NwcTransport,
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
import { registerPhotoRoutes } from './routes/photos';
import { createFsBlobStore, type BlobStore } from './lib/blob-store';
import { createMailer, type SendMail } from './lib/mailer';
import { createDbWalletResolver } from './lib/wallets';
import { createEnvEurRateProvider, type EurRateProvider } from './lib/eur-rate';
import type { LifecycleDeps } from './shipments/executor';

/** Non-injectable knobs the routes need beyond LifecycleDeps. */
export interface LifecycleConfig {
  secretKey: Buffer;
  fakeWalletsEnabled: boolean;
  /** Injected by tests to point NWC capability probing (ADR-019) at an
   *  in-process fake relay instead of a real WebSocket connection. */
  nwcTransportFactory?: (relays: string[]) => NwcTransport;
  /** Injected by tests to shrink the connect-time NWC probe timeout
   *  (production default: probeNwcWallet's own 8s). */
  nwcProbeTimeoutMs?: number;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    sendMail: SendMail;
    lifecycle: LifecycleDeps;
    lifecycleConfig: LifecycleConfig;
    eurRate: EurRateProvider;
    blobStore: BlobStore;
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
  /** Starting balance of a fake wallet on first resolution (dev demos). */
  fakeInitialBalanceMsat?: bigint;
  /** Sync-hold / instant-settlement polling knobs (tests tighten them). */
  waitAttempts?: number;
  waitDelayMs?: number;
  /** Injected by tests to point NWC capability probing (ADR-019) at an
   *  in-process fake relay instead of a real WebSocket connection. */
  nwcTransportFactory?: (relays: string[]) => NwcTransport;
  /** Injected by tests to shrink the connect-time NWC probe timeout
   *  (production default: probeNwcWallet's own 8s). */
  nwcProbeTimeoutMs?: number;
  /** Injected by tests (memory store); defaults to the filesystem driver on
   *  PHOTO_STORAGE_DIR (ADR-020). */
  blobStore?: BlobStore;
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
      ...(options.fakeInitialBalanceMsat !== undefined && {
        fakeInitialBalanceMsat: options.fakeInitialBalanceMsat,
      }),
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
    ...(options.nwcTransportFactory && { nwcTransportFactory: options.nwcTransportFactory }),
    ...(options.nwcProbeTimeoutMs !== undefined && {
      nwcProbeTimeoutMs: options.nwcProbeTimeoutMs,
    }),
  });
  app.decorate('eurRate', options.eurRate ?? createEnvEurRateProvider());
  // Photo blobs (ADR-020): filesystem driver, content-addressed by sha256.
  app.decorate(
    'blobStore',
    options.blobStore ?? createFsBlobStore(process.env.PHOTO_STORAGE_DIR ?? './data/photos'),
  );

  // Photo uploads are raw JPEG bodies (ADR-020 §3): parsed as a Buffer, with
  // the per-route bodyLimit as the size cap. The whitelist itself is decided
  // on magic bytes in the route, not on this header.
  app.addContentTypeParser('image/jpeg', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

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
  registerPhotoRoutes(app);

  return app;
}

/** The app type, with the Zod type provider and our decorations - route
 *  files import this instead of the bare `FastifyInstance` so that Zod
 *  schemas passed to `{ schema: { body } }` are actually inferred. */
export type App = Awaited<ReturnType<typeof buildApp>>;
