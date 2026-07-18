// Venue photos and the deposit-request email end to end (ADR-028, Fase 2 punto
// 6) on pglite + memory blob stores. The venue upload shares the shipment photo
// contract (ADR-020: verify the hash, refuse non-JPEG and GPS EXIF, never
// re-encode) but differs in authorization — the hub owns its venue photos, and
// reads are PUBLIC — so that surface is tested with the same care.

import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emailOutbox, hubPhotos, hubs } from '@mercurio/db';
import { MAX_VENUE_PHOTOS } from '@mercurio/shared';
import { sha256Hex } from '../lib/blob-store.js';
import { buildJpeg, buildJpegWithExif, PNG_MAGIC } from '../lib/photo-test-fixtures.js';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  type LifecycleWorld,
  type Persona,
} from './test-world.js';

function uploadVenue(world: LifecycleWorld, persona: Persona, sha: string, bytes: Buffer) {
  return world.app.inject({
    method: 'POST',
    url: `/hubs/mine/venue-photos/${sha}`,
    headers: { cookie: persona.cookie, 'content-type': 'image/jpeg' },
    payload: bytes,
  });
}

describe('hub venue photos (ADR-028)', () => {
  it('owner uploads; anyone reads the exact bytes back; re-upload is idempotent', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('venue-a');
    const sha = sha256Hex(jpeg);

    const up = await uploadVenue(world, world.mario, sha, jpeg);
    expect(up.statusCode).toBe(201);
    expect(up.json()).toMatchObject({ sha256: sha, duplicated: false });

    // Public list — NO session (unlike shipment photos, ADR-020 §4).
    const list = await world.app.inject({ method: 'GET', url: `/hubs/${world.hubA}/venue-photos` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { photos: { sha256: string }[] }).photos).toEqual([
      expect.objectContaining({ sha256: sha }),
    ]);

    // Public bytes — the exact bytes, with a shareable cache header.
    const bytes = await world.app.inject({
      method: 'GET',
      url: `/hubs/${world.hubA}/venue-photos/${sha}`,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.headers['content-type']).toBe('image/jpeg');
    expect(bytes.headers['cache-control']).toContain('public');
    expect(Buffer.from(bytes.rawPayload)).toEqual(jpeg);

    // Idempotent (content-addressed): a retry is a 200 no-op, one row.
    const again = await uploadVenue(world, world.mario, sha, jpeg);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ duplicated: true });
    expect(await world.db.select().from(hubPhotos)).toHaveLength(1);

    // It surfaces on the public hub list too (the sender's picker).
    const hubList = (await world.api({ method: 'GET', url: '/hubs' })).json() as {
      hubs: { id: string; venuePhotos: string[] }[];
    };
    expect(hubList.hubs.find((h) => h.id === world.hubA)?.venuePhotos).toEqual([sha]);
  });

  it('only the hub owner may upload; a non-hub user is refused', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('venue-b');
    const sha = sha256Hex(jpeg);
    // Marco is a sender, not a hub owner.
    const res = await uploadVenue(world, world.marco, sha, jpeg);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'not_a_hub' });
  });

  it('rejects a wrong hash, a non-JPEG and a GPS-tagged JPEG, never storing bytes', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('venue-c');
    const sha = sha256Hex(jpeg);

    const wrong = await uploadVenue(world, world.mario, sha, buildJpeg('other'));
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json()).toMatchObject({ error: 'photo_hash_mismatch' });

    const png = await uploadVenue(world, world.mario, sha256Hex(PNG_MAGIC), PNG_MAGIC);
    expect(png.statusCode).toBe(422);
    expect(png.json()).toMatchObject({ error: 'photo_format_unsupported' });

    const geo = buildJpegWithExif({ gps: true, label: 'venue' });
    const geoRes = await uploadVenue(world, world.mario, sha256Hex(geo), geo);
    expect(geoRes.statusCode).toBe(422);
    expect(geoRes.json()).toMatchObject({ error: 'photo_exif_gps' });

    expect(await world.db.select().from(hubPhotos)).toHaveLength(0);
  });

  it('caps the gallery at MAX_VENUE_PHOTOS', async () => {
    const world = await createLifecycleWorld();
    for (let i = 0; i < MAX_VENUE_PHOTOS; i++) {
      const jpeg = buildJpeg(`venue-cap-${i}`);
      const res = await uploadVenue(world, world.mario, sha256Hex(jpeg), jpeg);
      expect(res.statusCode).toBe(201);
    }
    const overflow = buildJpeg('venue-cap-overflow');
    const res = await uploadVenue(world, world.mario, sha256Hex(overflow), overflow);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'venue_photos_full', max: MAX_VENUE_PHOTOS });
  });

  it('owner deletes; the photo and its blob disappear', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('venue-del');
    const sha = sha256Hex(jpeg);
    await uploadVenue(world, world.mario, sha, jpeg);

    const del = await world.api({
      method: 'DELETE',
      url: `/hubs/mine/venue-photos/${sha}`,
      cookie: world.mario.cookie,
      expect: 200,
    });
    expect(del.json()).toMatchObject({ deleted: true });

    expect(await world.db.select().from(hubPhotos)).toHaveLength(0);
    const gone = await world.app.inject({
      method: 'GET',
      url: `/hubs/${world.hubA}/venue-photos/${sha}`,
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('deposit-request email (ADR-028)', () => {
  it('a manual origin hub is notified at its account email when a shipment is created', async () => {
    const world = await createLifecycleWorld();
    // Turn OFF auto-accept: the shipment stays a real deposit REQUEST.
    await world.db.update(hubs).set({ autoAccept: false }).where(eq(hubs.id, world.hubA));

    const created = await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
      expect: 201,
    });
    expect((created.json() as { status: string }).status).toBe('DRAFT');

    const rows = await world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'hub_deposit_request'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.to).toBe(world.mario.email);
    expect(rows[0]!.payload).toMatchObject({ hubId: world.hubA, destHubId: world.hubB });
  });

  it('an auto-accepting origin hub gets NO deposit-request email (it already accepted)', async () => {
    const world = await createLifecycleWorld(); // hubs auto-accept by default
    await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: { ...CANONICAL_CREATE_BODY, originHubId: world.hubA, destHubId: world.hubB },
      expect: 201,
    });
    const rows = await world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'hub_deposit_request'));
    expect(rows).toHaveLength(0);
  });
});
