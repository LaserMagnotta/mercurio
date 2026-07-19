// Shared fixture for coordinator tests (unit and integration): a minimal
// Mercurio world — users, two hubs, one shipment — satisfying the FK chain
// conditional_payments -> shipments -> hubs -> users. The Lightning side is
// provided by the caller (fake network or regtest nodes): this only covers
// the database rows the coordinator and the shadow ledger need.

import { hubs, shipments, users } from '@mercurio/db';
import { createTestDb } from '@mercurio/db/test-helpers';

export interface EscrowWorld {
  db: Awaited<ReturnType<typeof createTestDb>>;
  senderId: string;
  carrierId: string;
  hubOwnerId: string;
  shipmentId: string;
}

export async function createEscrowWorld(): Promise<EscrowWorld> {
  const db = await createTestDb();

  const emails = ['sender@test.local', 'carrier@test.local', 'hub-a@test.local', 'hub-b@test.local'];
  const [sender, carrier, hubOwnerA, hubOwnerB] = await db
    .insert(users)
    .values(emails.map((email) => ({ email, locale: 'it' })))
    .returning();
  if (!sender || !carrier || !hubOwnerA || !hubOwnerB) throw new Error('fixture: users failed');

  const hubDefaults = {
    openingHours: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => ({
      day,
      opens: '08:00',
      closes: '20:00',
    })),
    maxDimCmL: 50,
    maxDimCmW: 50,
    maxDimCmH: 50,
    maxWeightG: 15000,
    acceptsUndeclared: true,
    feePercent: '10.00',
    maxStorageDays: 3,
    autoAccept: true,
    active: true,
  };
  const [hubA, hubB] = await db
    .insert(hubs)
    .values([
      { userId: hubOwnerA.id, name: 'Hub A', address: 'Via A 1', lat: 44.49, lng: 11.34, ...hubDefaults },
      { userId: hubOwnerB.id, name: 'Hub B', address: 'Via B 2', lat: 43.77, lng: 11.26, ...hubDefaults },
    ])
    .returning();
  if (!hubA || !hubB) throw new Error('fixture: hubs failed');

  const [shipment] = await db
    .insert(shipments)
    .values({
      senderId: sender.id,
      originHubId: hubA.id,
      destHubId: hubB.id,
      recipientEmail: 'recipient@test.local',
      qrToken: crypto.randomUUID(),
      codename: 'Volpe-Argentea-314',
      dimLCm: 20,
      dimWCm: 15,
      dimHCm: 5,
      weightG: 200,
      offerMsat: 7_500_000n,
      custodyBondMsat: 22_500_000n,
      maxStorageDays: 2,
      eurRateSnapshot: '1500',
      eurRateSource: 'test-fixture',
      eurRateAt: new Date(),
      status: 'at_hub',
      distanceKm: 100,
    })
    .returning();
  if (!shipment) throw new Error('fixture: shipment failed');

  return {
    db,
    senderId: sender.id,
    carrierId: carrier.id,
    hubOwnerId: hubOwnerA.id,
    shipmentId: shipment.id,
  };
}
