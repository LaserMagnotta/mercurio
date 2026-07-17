// Shared world for the lifecycle test suites: pglite + the fake Lightning
// network + an injected clock + a flat synthetic geography, all wired into a
// real buildApp() so the tests exercise the HTTP surface end to end.
//
// Geography: coordinates are (lat, lng) treated as plane km — hub A at
// lng 0, hub C at lng 40, hub B at lng 100 reproduce the canonical example
// EXACTLY (A→C 40 km, C→B 60 km, A→B 100 km) with no haversine noise.
// Money: EUR rate frozen at 1600 sats/€, so the 5 € offer is 8 000 000 msat
// and every figure of ECONOMICS.md §5-bis is representable to the msat.

import { randomBytes, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  carrierProfiles,
  findOrCreateAccount,
  getAccountBalance,
  hubs,
  users,
  walletConnections,
} from '@mercurio/db';
import { createTestDb } from '@mercurio/db/test-helpers';
import type { DistanceProvider } from '@mercurio/core';
import {
  FakeLightningNetwork,
  PreimageCoordinator,
  type FakeWalletConnection,
} from '@mercurio/escrow';
import { buildApp, type App } from '../app.js';
import { createMemoryBlobStore } from '../lib/blob-store.js';
import { createSession } from '../lib/session.js';
import { sealSecret } from '../lib/secret-box.js';

export const SATS_PER_EUR = '1600';
export const INITIAL_BALANCE_MSAT = 200_000_000n;

/** The canonical shipment (CLAUDE.md flow): 5 € offer, 15 € bond @1600. */
export const OFFER_MSAT = 8_000_000n;
export const BOND_MSAT = 24_000_000n;

export interface TestClock {
  nowMs: number;
  advanceMinutes(minutes: number): void;
  advanceHours(hours: number): void;
}

export interface Persona {
  id: string;
  email: string;
  cookie: string;
  wallet: FakeWalletConnection;
}

export interface LifecycleWorld {
  app: App;
  db: Awaited<ReturnType<typeof createTestDb>>;
  network: FakeLightningNetwork;
  clock: TestClock;
  /** Every user the wallet resolver was asked for (zero-custody audit). */
  resolvedWalletUsers: Set<string>;
  sentEmails: { to: string; subject: string; text: string }[];
  marco: Persona; // sender
  luca: Persona; // carrier of the first leg
  anna: Persona; // carrier of the final leg
  mario: Persona; // hub A (origin) owner
  carla: Persona; // hub C (intermediate) owner
  bruno: Persona; // hub B (destination) owner
  rita: Persona; // recipient (account + wallet: she can claim, ADR-016)
  hubA: string;
  hubC: string;
  hubB: string;
  balance(persona: Persona): bigint;
  commitmentBalance(shipmentId: string): Promise<bigint>;
  api(input: {
    method: 'GET' | 'POST' | 'DELETE';
    url: string;
    cookie?: string;
    body?: unknown;
    expect?: number;
  }): Promise<{ status: number; json: () => unknown }>;
}

/** Plane geometry: degrees read as km. Deterministic and exact. */
const flatDistance: DistanceProvider = {
  distanceKm: (a, b) => Math.hypot(a.lat - b.lat, a.lng - b.lng),
};

const HUB_DEFAULTS = {
  openingHours: { 'mon-sat': '08:00-20:00' },
  maxDimCmL: 50,
  maxDimCmW: 50,
  maxDimCmH: 50,
  maxWeightG: 15_000,
  acceptsUndeclared: true,
  feePercent: '10.00',
  maxStorageDays: 7,
  autoAccept: true,
  active: true,
};

export async function createLifecycleWorld(): Promise<LifecycleWorld> {
  const db = await createTestDb();
  const clock: TestClock = {
    nowMs: Date.UTC(2026, 6, 13, 8, 0, 0),
    advanceMinutes(minutes) {
      this.nowMs += minutes * 60_000;
    },
    advanceHours(hours) {
      this.nowMs += hours * 3_600_000;
    },
  };
  const now = () => new Date(clock.nowMs);
  const network = new FakeLightningNetwork(() => clock.nowMs);
  const coordinatorKey = randomBytes(32);

  const emails = [
    'marco@test.local',
    'luca@test.local',
    'anna@test.local',
    'mario@test.local',
    'carla@test.local',
    'bruno@test.local',
    // Rita's account email matches CANONICAL_CREATE_BODY.recipientEmail: she
    // is the addressee of the tracking mail and the canonical claimant.
    'destinataria@test.local',
  ];
  const userRows = await db
    .insert(users)
    .values(emails.map((email) => ({ email, locale: 'it' })))
    .returning();
  const wallets = new Map<string, FakeWalletConnection>();
  const resolvedWalletUsers = new Set<string>();
  for (const row of userRows) {
    wallets.set(row.id, network.wallet(row.id, INITIAL_BALANCE_MSAT));
    await db.insert(walletConnections).values({
      userId: row.id,
      kind: 'fake',
      connectionSecretEncrypted: sealSecret(row.id, coordinatorKey),
      capabilities: { holdInvoice: true },
      status: 'connected',
    });
  }
  const resolveWallet = async (userId: string) => {
    resolvedWalletUsers.add(userId);
    const wallet = wallets.get(userId);
    if (!wallet) throw new Error(`test world: no wallet for ${userId}`);
    return wallet;
  };

  const coordinator = new PreimageCoordinator({
    db,
    resolveWallet,
    coordinatorKey,
    now: () => clock.nowMs,
  });

  const sentEmails: LifecycleWorld['sentEmails'] = [];
  const app = await buildApp({
    db,
    sendMail: async (mail) => {
      sentEmails.push(mail);
    },
    coordinator,
    walletResolver: resolveWallet,
    distanceProvider: flatDistance,
    eurRate: {
      snapshot: async () => ({ satsPerEur: SATS_PER_EUR, source: 'test-fixed', at: now() }),
    },
    now,
    coordinatorKey,
    fakeNetwork: network,
    waitAttempts: 5,
    waitDelayMs: 1,
    // Photo blobs stay in memory (ADR-020): tests never touch the disk.
    blobStore: createMemoryBlobStore(now),
  });
  await app.ready();

  // Personas: carriers activate the role; hub owners get their hub row.
  const persona = async (index: number): Promise<Persona> => {
    const row = userRows[index]!;
    const { token } = await createSession(db, row.id);
    return {
      id: row.id,
      email: row.email,
      cookie: `mercurio_session=${token}`,
      wallet: wallets.get(row.id)!,
    };
  };
  const [marco, luca, anna, mario, carla, bruno, rita] = await Promise.all([
    persona(0),
    persona(1),
    persona(2),
    persona(3),
    persona(4),
    persona(5),
    persona(6),
  ]);
  await db.insert(carrierProfiles).values([{ userId: luca!.id }, { userId: anna!.id }]);
  const hubRows = await db
    .insert(hubs)
    .values([
      { userId: mario!.id, name: 'Hub A', address: 'Via A 1', lat: 0, lng: 0, ...HUB_DEFAULTS },
      { userId: carla!.id, name: 'Hub C', address: 'Via C 1', lat: 0, lng: 40, ...HUB_DEFAULTS },
      { userId: bruno!.id, name: 'Hub B', address: 'Via B 1', lat: 0, lng: 100, ...HUB_DEFAULTS },
    ])
    .returning();

  const api: LifecycleWorld['api'] = async ({ method, url, cookie, body, expect: expected }) => {
    const res = await app.inject({
      method,
      url,
      ...(cookie && { headers: { cookie } }),
      ...(body !== undefined && { payload: body as Record<string, unknown> }),
    });
    if (expected !== undefined) {
      expect(res.statusCode, `${method} ${url} → ${res.body}`).toBe(expected);
    }
    return { status: res.statusCode, json: () => res.json() as unknown };
  };

  return {
    app,
    db,
    network,
    clock,
    resolvedWalletUsers,
    sentEmails,
    marco: marco!,
    luca: luca!,
    anna: anna!,
    mario: mario!,
    carla: carla!,
    bruno: bruno!,
    rita: rita!,
    hubA: hubRows[0]!.id,
    hubC: hubRows[1]!.id,
    hubB: hubRows[2]!.id,
    balance: (p) => network.balanceOf(p.id),
    commitmentBalance: async (shipmentId) => {
      const accountId = await findOrCreateAccount(db, {
        ownerType: 'shipment',
        ownerId: shipmentId,
        kind: 'commitment',
      });
      return getAccountBalance(db, accountId);
    },
    api,
  };
}

// ---------------------------------------------------------------------------
// Reusable flow fragments

export const CANONICAL_CREATE_BODY = {
  recipientEmail: 'destinataria@test.local',
  dims: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  weightG: 200,
  declaredContent: 'penne',
  undeclared: false,
  offerMsat: OFFER_MSAT.toString(),
  custodyBondMsat: BOND_MSAT.toString(),
  maxStorageDays: 3,
};

/** Create the canonical shipment (auto-accepted by hub A) and check it in:
 *  leaves it AT_HUB at the origin with the storage timer armed. */
export async function createShipmentAtHub(
  world: LifecycleWorld,
): Promise<{ id: string; qrToken: string }> {
  const created = await world.api({
    method: 'POST',
    url: '/shipments',
    cookie: world.marco.cookie,
    body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
    expect: 201,
  });
  const { id, qrToken, originAccepted } = created.json() as {
    id: string;
    qrToken: string;
    originAccepted: boolean;
  };
  expect(originAccepted).toBe(true);
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/origin-checkin`,
    cookie: world.mario.cookie,
    body: { qrToken, photoSha256: [sha('drop-off')] },
    expect: 200,
  });
  return { id, qrToken };
}

/** Declare a trip whose direct route passes near the given drop, so the
 *  board proposes it with zero detour. */
export async function declareTrip(
  world: LifecycleWorld,
  persona: Persona,
  originLng: number,
  destLng: number,
): Promise<string> {
  const res = await world.api({
    method: 'POST',
    url: '/trips',
    cookie: persona.cookie,
    body: {
      originLat: 0,
      originLng,
      destLat: 0,
      destLng,
      maxDeviationKm: 15,
      minRateMsatPerKm: '20000',
    },
    expect: 201,
  });
  return (res.json() as { id: string }).id;
}

/** Deterministic 64-hex "photo hash" for tests. */
export function sha(label: string): string {
  return label
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0).toString(16), '')
    .padEnd(64, '0')
    .slice(0, 64);
}

/** Both halves of the double-confirmation checkout (hub photo + carrier). */
export async function doubleConfirmCheckout(
  world: LifecycleWorld,
  shipmentId: string,
  qrToken: string,
  hubOwner: Persona,
  carrier: Persona,
): Promise<void> {
  const first = await world.api({
    method: 'POST',
    url: `/shipments/${shipmentId}/pickup-checkout`,
    cookie: hubOwner.cookie,
    body: { qrToken, photoSha256: [sha('checkout')] },
    expect: 200,
  });
  expect((first.json() as { complete: boolean }).complete).toBe(false);
  const second = await world.api({
    method: 'POST',
    url: `/shipments/${shipmentId}/pickup-checkout`,
    cookie: carrier.cookie,
    body: { qrToken },
    expect: 200,
  });
  expect((second.json() as { complete: boolean }).complete).toBe(true);
}

export function uuid(): string {
  return randomUUID();
}
