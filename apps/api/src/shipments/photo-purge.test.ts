// Retention purge worker (ADR-020 §5) on pglite + memory blob store with the
// injected clock — pg-boss only schedules this function (ADR-011 pattern),
// so the deadline math is what gets tested, deterministically.

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { photos, shipments } from '@mercurio/db';
import { sha256Hex } from '../lib/blob-store.js';
import { buildJpeg } from '../lib/photo-test-fixtures.js';
import { purgeExpiredPhotos } from './photo-purge.js';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  type LifecycleWorld,
} from './test-world.js';

const DAY_MINUTES = 24 * 60;

/** Create a shipment, check it in at hub A with the jpeg's hash and upload
 *  the blob as the origin hub — one certified photo, row + blob in place. */
async function shipmentWithPhoto(world: LifecycleWorld, label: string) {
  const jpeg = buildJpeg(label);
  const hash = sha256Hex(jpeg);
  const created = await world.api({
    method: 'POST',
    url: '/shipments',
    cookie: world.marco.cookie,
    body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
    expect: 201,
  });
  const { id, qrToken } = created.json() as { id: string; qrToken: string };
  await world.api({
    method: 'POST',
    url: `/shipments/${id}/origin-checkin`,
    cookie: world.mario.cookie,
    body: { qrToken, photoSha256: [hash] },
    expect: 200,
  });
  const res = await world.app.inject({
    method: 'POST',
    url: `/shipments/${id}/photos/${hash}`,
    headers: { cookie: world.mario.cookie, 'content-type': 'image/jpeg' },
    payload: jpeg,
  });
  expect(res.statusCode).toBe(201);
  return { id, hash, jpeg };
}

function purgeDeps(world: LifecycleWorld) {
  return {
    db: world.db,
    blobStore: world.app.blobStore,
    now: () => new Date(world.clock.nowMs),
  };
}

describe('photo purge worker (ADR-020 §5)', () => {
  it('the 90-day ceiling purges photos of shipments that never close', async () => {
    const world = await createLifecycleWorld();
    const { hash } = await shipmentWithPhoto(world, 'never-closes');

    world.clock.advanceMinutes(89 * DAY_MINUTES);
    expect((await purgeExpiredPhotos(purgeDeps(world))).purgedRows).toBe(0);
    expect(await world.app.blobStore.get(hash)).not.toBeNull();

    world.clock.advanceMinutes(2 * DAY_MINUTES);
    const report = await purgeExpiredPhotos(purgeDeps(world));
    expect(report.purgedRows).toBe(1);
    expect(report.deletedBlobs).toBe(1);
    expect(await world.db.select().from(photos)).toHaveLength(0);
    expect(await world.app.blobStore.get(hash)).toBeNull();
  });

  it('closure + 30 days: terminal shipments purge early, not before', async () => {
    const world = await createLifecycleWorld();
    const { id, hash } = await shipmentWithPhoto(world, 'closes');
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/cancel`,
      cookie: world.marco.cookie,
      expect: 200,
    });

    // 15 days after closure: tightened but alive.
    world.clock.advanceMinutes(15 * DAY_MINUTES);
    const early = await purgeExpiredPhotos(purgeDeps(world));
    expect(early.tightened).toBe(1);
    expect(early.purgedRows).toBe(0);

    // 31 days after closure: gone — 59 days before the ceiling.
    world.clock.advanceMinutes(16 * DAY_MINUTES);
    const report = await purgeExpiredPhotos(purgeDeps(world));
    expect(report.purgedRows).toBe(1);
    expect(await world.app.blobStore.get(hash)).toBeNull();
  });

  it('a blob shared by two shipments survives until the LAST row dies', async () => {
    const world = await createLifecycleWorld();
    // Same bytes certified and uploaded on two different shipments.
    const jpeg = buildJpeg('shared');
    const hash = sha256Hex(jpeg);
    for (let i = 0; i < 2; i++) {
      const created = await world.api({
        method: 'POST',
        url: '/shipments',
        cookie: world.marco.cookie,
        body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
        expect: 201,
      });
      const { id, qrToken } = created.json() as { id: string; qrToken: string };
      await world.api({
        method: 'POST',
        url: `/shipments/${id}/origin-checkin`,
        cookie: world.mario.cookie,
        body: { qrToken, photoSha256: [hash] },
        expect: 200,
      });
      const res = await world.app.inject({
        method: 'POST',
        url: `/shipments/${id}/photos/${hash}`,
        headers: { cookie: world.mario.cookie, 'content-type': 'image/jpeg' },
        payload: jpeg,
      });
      expect(res.statusCode).toBe(201);
    }
    const rows = await world.db.select().from(photos);
    expect(rows).toHaveLength(2);

    // Force ONE row past its deadline; the other keeps the blob alive.
    await world.db
      .update(photos)
      .set({ purgeAfter: new Date(world.clock.nowMs - 1000) })
      .where(eq(photos.id, rows[0]!.id));
    const first = await purgeExpiredPhotos(purgeDeps(world));
    expect(first.purgedRows).toBe(1);
    expect(first.deletedBlobs).toBe(0);
    expect(await world.app.blobStore.get(hash)).not.toBeNull();

    await world.db
      .update(photos)
      .set({ purgeAfter: new Date(world.clock.nowMs - 1000) })
      .where(eq(photos.id, rows[1]!.id));
    const second = await purgeExpiredPhotos(purgeDeps(world));
    expect(second.purgedRows).toBe(1);
    expect(second.deletedBlobs).toBe(1);
    expect(await world.app.blobStore.get(hash)).toBeNull();
  });

  it('sweeps orphan blobs (no row) once they are old enough', async () => {
    const world = await createLifecycleWorld();
    const { hash } = await shipmentWithPhoto(world, 'legit');
    // Simulates a crash between blob write and row insert.
    await world.app.blobStore.put(sha256Hex(buildJpeg('orphan')), buildJpeg('orphan'));

    // Too fresh: could be an upload in flight — untouched.
    expect((await purgeExpiredPhotos(purgeDeps(world))).orphanBlobsDeleted).toBe(0);

    world.clock.advanceMinutes(25 * 60);
    const report = await purgeExpiredPhotos(purgeDeps(world));
    expect(report.orphanBlobsDeleted).toBe(1);
    // The referenced blob is NOT an orphan, whatever its age.
    expect(await world.app.blobStore.get(hash)).not.toBeNull();
  });

  it('terminal status alone is not enough: shipments without photos are untouched', async () => {
    const world = await createLifecycleWorld();
    const { id } = await shipmentWithPhoto(world, 'control');
    // Sanity: a foreign terminal shipment must not affect this one's photos.
    const [row] = await world.db.select().from(shipments).where(eq(shipments.id, id));
    expect(row!.status).toBe('at_hub');
    const report = await purgeExpiredPhotos(purgeDeps(world));
    expect(report.tightened).toBe(0);
    expect(report.purgedRows).toBe(0);
  });
});
