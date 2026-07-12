import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@mercurio/db/test-helpers';
import { hubs, users } from '@mercurio/db';
import { activateCarrierRole, deleteAccount, exportUserData, getRoles } from './account';
import { createSession, getSessionUserId } from './session';

async function makeUser(db: Awaited<ReturnType<typeof createTestDb>>, email: string) {
  const [user] = await db.insert(users).values({ email }).returning();
  if (!user) throw new Error('setup failed');
  return user;
}

describe('roles', () => {
  it('a fresh account has no carrier/hub role active', async () => {
    const db = await createTestDb();
    const user = await makeUser(db, 'plain@example.com');
    expect(await getRoles(db, user.id)).toEqual({ carrier: false, hub: false });
  });

  it('activating the carrier role is idempotent', async () => {
    const db = await createTestDb();
    const user = await makeUser(db, 'carrier@example.com');

    await activateCarrierRole(db, user.id);
    await activateCarrierRole(db, user.id); // must not throw a unique-constraint error

    expect(await getRoles(db, user.id)).toEqual({ carrier: true, hub: false });
  });
});

describe('GDPR: data export', () => {
  it("exports the user's own data (account, hubs, shipments sent, reviews, consent)", async () => {
    const db = await createTestDb();
    const user = await makeUser(db, 'exportme@example.com');
    await db.insert(hubs).values({
      userId: user.id,
      name: 'Test hub',
      address: 'Somewhere 1',
      lat: 0,
      lng: 0,
      openingHours: {},
      maxDimCmL: 10,
      maxDimCmW: 10,
      maxDimCmH: 10,
      maxWeightG: 1000,
      acceptsUndeclared: false,
      feePercent: '10.00',
      maxStorageHours: 24,
      autoAccept: true,
      active: true,
    });

    const data = await exportUserData(db, user.id);

    expect(data.user.email).toBe('exportme@example.com');
    expect(data.hubs).toHaveLength(1);
    expect(data.hubs[0]?.name).toBe('Test hub');
  });
});

describe('GDPR: account deletion (anonymization)', () => {
  it('anonymizes the email, sets deletedAt, and revokes sessions', async () => {
    const db = await createTestDb();
    const user = await makeUser(db, 'deleteme@example.com');
    const { token } = await createSession(db, user.id);

    await deleteAccount(db, user.id);

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row?.email).not.toBe('deleteme@example.com');
    expect(row?.email).toContain('anonymized.invalid');
    expect(row?.deletedAt).not.toBeNull();
    expect(await getSessionUserId(db, token)).toBeNull();
  });

  it('deactivates (does not delete) a hub the user owned', async () => {
    const db = await createTestDb();
    const user = await makeUser(db, 'hubowner@example.com');
    const [hub] = await db
      .insert(hubs)
      .values({
        userId: user.id,
        name: 'Owned hub',
        address: 'Somewhere 2',
        lat: 0,
        lng: 0,
        openingHours: {},
        maxDimCmL: 10,
        maxDimCmW: 10,
        maxDimCmH: 10,
        maxWeightG: 1000,
        acceptsUndeclared: false,
        feePercent: '10.00',
        maxStorageHours: 24,
        autoAccept: true,
        active: true,
      })
      .returning();
    if (!hub) throw new Error('setup failed');

    await deleteAccount(db, user.id);

    const [row] = await db.select().from(hubs).where(eq(hubs.id, hub.id));
    expect(row).toBeDefined(); // still exists (referential integrity for past shipments)
    expect(row?.active).toBe(false);
  });
});
