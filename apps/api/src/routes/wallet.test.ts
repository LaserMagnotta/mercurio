// /me/wallet route tests (ADR-013, ADR-019): validation, capability probing
// and storage for kind:'nwc', plus the pre-existing fake/lnd_rest paths.
// Uses the REAL DB-backed wallet resolver (buildApp with no walletResolver
// override) so the route and createDbWalletResolver are exercised together —
// only the NWC relay transport is swapped for an in-process fake.

import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '@mercurio/db';
import { createTestDb } from '@mercurio/db/test-helpers';
import {
  FakeLightningNetwork,
  FakeNwcWalletService,
  InMemoryNwcTransport,
  InMemoryRelay,
  type NwcTransport,
} from '@mercurio/escrow';
import { buildApp, type App } from '../app.js';
import { createSession } from '../lib/session.js';

async function setUpUser(db: Awaited<ReturnType<typeof createTestDb>>) {
  const [row] = await db
    .insert(users)
    .values({ email: 'wallet-test@test.local', locale: 'it' })
    .returning();
  const { token } = await createSession(db, row!.id);
  return { userId: row!.id, cookie: `mercurio_session=${token}` };
}

describe('/me/wallet', () => {
  let app: App;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let cookie: string;

  beforeEach(async () => {
    db = await createTestDb();
    ({ cookie } = await setUpUser(db));
  });

  describe('kind: fake', () => {
    it('is rejected when fake wallets are disabled (no fakeNetwork configured)', async () => {
      app = await buildApp({ db, coordinatorKey: randomBytes(32) });
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: { kind: 'fake', connectionSecret: 'alice' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'fake_wallets_disabled' });
    });

    it('connects when fake wallets are enabled', async () => {
      app = await buildApp({
        db,
        coordinatorKey: randomBytes(32),
        fakeNetwork: new FakeLightningNetwork(),
      });
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: { kind: 'fake', connectionSecret: 'alice' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ kind: 'fake', status: 'connected' });
    });
  });

  describe('kind: nwc', () => {
    it('rejects a malformed connection string', async () => {
      app = await buildApp({ db, coordinatorKey: randomBytes(32) });
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: { kind: 'nwc', connectionSecret: 'not-a-uri-at-all' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'nwc_invalid_connection_string' });
    });

    it('reports nwc_connection_failed when the wallet never answers', async () => {
      const relay = new InMemoryRelay(); // no wallet service listening
      const nwcTransportFactory = () => new InMemoryNwcTransport(relay);
      app = await buildApp({
        db,
        coordinatorKey: randomBytes(32),
        nwcTransportFactory,
        nwcProbeTimeoutMs: 200,
      });
      await app.ready();
      const walletPubkey = randomBytes(32).toString('hex');
      const res = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: {
          kind: 'nwc',
          connectionSecret: `nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://fake')}&secret=${randomBytes(32).toString('hex')}`,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'nwc_connection_failed' });
    });

    it('connects and stores holdInvoice=true for a hold-capable wallet', async () => {
      const relay = new InMemoryRelay();
      const network = new FakeLightningNetwork();
      network.wallet('nwc-user', 0n);
      const service = new FakeNwcWalletService({
        relay,
        network,
        walletId: 'nwc-user',
        secretKey: randomBytes(32).toString('hex'),
      });
      const nwcTransportFactory: (relays: string[]) => NwcTransport = () =>
        new InMemoryNwcTransport(relay);
      app = await buildApp({ db, coordinatorKey: randomBytes(32), nwcTransportFactory });
      await app.ready();

      const uri = `nostr+walletconnect://${service.pubkey}?relay=${encodeURIComponent('wss://fake')}&secret=${randomBytes(32).toString('hex')}`;
      const connectRes = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: { kind: 'nwc', connectionSecret: uri },
      });
      expect(connectRes.statusCode, connectRes.body).toBe(201);
      expect(connectRes.json()).toMatchObject({ kind: 'nwc', status: 'connected' });

      const getRes = await app.inject({ method: 'GET', url: '/me/wallet', headers: { cookie } });
      expect(getRes.json()).toMatchObject({ wallet: { kind: 'nwc', status: 'connected' } });

      service.close();
    });

    it('rejects a wallet missing the baseline methods (pay_invoice/make_invoice/lookup_invoice)', async () => {
      const relay = new InMemoryRelay();
      // get_info answers, but advertises only itself — a wallet implementing
      // neither the base methods nor the hold-invoice extension.
      const service = new FakeNwcWalletService({
        relay,
        network: new FakeLightningNetwork(),
        walletId: 'irrelevant',
        secretKey: randomBytes(32).toString('hex'),
        supportsHoldInvoice: false,
        baseMethods: ['get_info'],
      });
      const nwcTransportFactory: (relays: string[]) => NwcTransport = () =>
        new InMemoryNwcTransport(relay);
      app = await buildApp({ db, coordinatorKey: randomBytes(32), nwcTransportFactory });
      await app.ready();

      const uri = `nostr+walletconnect://${service.pubkey}?relay=${encodeURIComponent('wss://fake')}&secret=${randomBytes(32).toString('hex')}`;
      const res = await app.inject({
        method: 'POST',
        url: '/me/wallet',
        headers: { cookie },
        payload: { kind: 'nwc', connectionSecret: uri },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'nwc_missing_required_methods' });
      service.close();
    });
  });

  afterEach(async () => {
    await app?.close();
  });
});
