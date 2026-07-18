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
import authGuard from './plugins/auth-guard.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerMeRoutes } from './routes/me.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerHubRoutes } from './routes/hubs.js';
import { registerTripRoutes } from './routes/trips.js';
import { registerShipmentRoutes } from './routes/shipments.js';
import { registerShipmentLifecycleRoutes } from './routes/shipment-lifecycle.js';
import { registerReviewRoutes } from './routes/reviews.js';
import { registerPhotoRoutes } from './routes/photos.js';
import {
  createBlobStoreFromEnv,
  createVenueBlobStoreFromEnv,
  type BlobStore,
} from './lib/blob-store.js';
import { createMailer, type SendMail } from './lib/mailer.js';
import { createDbWalletResolver } from './lib/wallets.js';
import { createEurRateProviderFromEnv, type EurRateProvider } from './lib/eur-rate.js';
import type { LifecycleDeps } from './shipments/executor.js';

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
    /** Venue photos (ADR-028): a SEPARATE store from `blobStore`, isolated from
     *  the shipment photo purge worker. */
    venueBlobStore: BlobStore;
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
  /** Injected by tests (memory store); defaults to the driver selected by
   *  PHOTO_STORAGE_DRIVER (ADR-020 fs / ADR-023 s3). */
  blobStore?: BlobStore;
  /** Injected by tests (memory store); the venue photo store (ADR-028), always
   *  distinct from `blobStore`. */
  venueBlobStore?: BlobStore;
  /** Read `X-Forwarded-For` as the client address; defaults to TRUST_PROXY. */
  trustProxy?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: process.env.NODE_ENV !== 'test',
    // Behind the production reverse proxy (ADR-024) every request reaches
    // Fastify from the proxy's own address, so @fastify/rate-limit — which
    // keys its buckets on `request.ip` — would put the entire internet in ONE
    // bucket and the anti-abuse limits of RISKS §7 would fire on innocent
    // users. Off unless asked: trusting `X-Forwarded-For` with nothing in
    // front to overwrite it lets any client forge its own address and get a
    // fresh quota per request, which is the same control failed open.
    trustProxy: options.trustProxy ?? process.env.TRUST_PROXY === 'true',
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
  // EUR→sats snapshot (ADR-008): fixed rate or real tickers, from
  // EUR_RATE_PROVIDER (ADR-025). Defaults to the fixed one, so nothing here
  // reaches the network unless a deploy asked for it.
  app.decorate('eurRate', options.eurRate ?? createEurRateProviderFromEnv());
  // Photo blobs (ADR-020, ADR-023): fs or S3-compatible driver from config,
  // content-addressed by sha256.
  app.decorate('blobStore', options.blobStore ?? createBlobStoreFromEnv());
  // Venue photos (ADR-028): same driver, separate location — never swept by the
  // shipment photo purge worker.
  app.decorate('venueBlobStore', options.venueBlobStore ?? createVenueBlobStoreFromEnv());

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
  // Awaited for the same reason as @fastify/swagger above: the per-route
  // limits are attached by an onRoute hook, so registering without awaiting
  // leaves every limit — global and per-route — silently inert (regression
  // covered by rate-limit.test.ts).
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
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
