import { describe, expect, it } from 'vitest';
import { createTestDb } from './test-helpers.js';
import { seedDemoData } from './seed-data.js';
import { hubs, shipments, users } from './schema/index.js';

describe('seedDemoData', () => {
  it('creates 3 users, 3 hubs and 1 shipment', async () => {
    const db = await createTestDb();

    await seedDemoData(db);

    expect(await db.select().from(users)).toHaveLength(3);
    expect(await db.select().from(hubs)).toHaveLength(3);
    expect(await db.select().from(shipments)).toHaveLength(1);
  });

  it('is idempotent: running it twice does not duplicate data', async () => {
    const db = await createTestDb();

    await seedDemoData(db);
    await seedDemoData(db);

    expect(await db.select().from(users)).toHaveLength(3);
    expect(await db.select().from(shipments)).toHaveLength(1);
  });
});
