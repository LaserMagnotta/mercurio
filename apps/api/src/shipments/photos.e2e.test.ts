// Photo blob endpoints end to end (ADR-020) on pglite + memory blob store.
// The authz surface is the sensitive part of this feature and is tested with
// the same rigor as the money suites: who can upload (only the declared
// photographer of a certified hash), who can view (participants only), and
// every 403/404/422 in between. The hash contract is asserted literally:
// bytes hashed on "device" == bytes uploaded == bytes served.

import { describe, expect, it } from 'vitest';
import { emailOutbox, photos } from '@mercurio/db';
import { PHOTO_MAX_BYTES } from '@mercurio/shared';
import { sha256Hex } from '../lib/blob-store';
import { buildJpeg, buildJpegWithExif, PNG_MAGIC } from '../lib/photo-test-fixtures';
import { pumpWalletEvents } from './pump';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  declareTrip,
  type LifecycleWorld,
  type Persona,
} from './test-world';

/** Create the canonical shipment and check it in at hub A declaring the
 *  given REAL photo hashes (test-world's createShipmentAtHub declares a
 *  synthetic hash, useless for upload tests). */
async function createWithPhotos(
  world: LifecycleWorld,
  photoSha256: string[],
): Promise<{ id: string; qrToken: string }> {
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
    body: { qrToken, photoSha256 },
    expect: 200,
  });
  return { id, qrToken };
}

async function upload(
  world: LifecycleWorld,
  persona: Persona,
  shipmentId: string,
  sha256: string,
  bytes: Buffer,
) {
  const res = await world.app.inject({
    method: 'POST',
    url: `/shipments/${shipmentId}/photos/${sha256}`,
    headers: { cookie: persona.cookie, 'content-type': 'image/jpeg' },
    payload: bytes,
  });
  return { status: res.statusCode, json: () => res.json() as Record<string, unknown> };
}

async function download(world: LifecycleWorld, persona: Persona, shipmentId: string, sha: string) {
  return world.app.inject({
    method: 'GET',
    url: `/shipments/${shipmentId}/photos/${sha}`,
    headers: { cookie: persona.cookie },
  });
}

describe('photo upload → download (ADR-020)', () => {
  it('the certified photographer uploads, participants download the exact bytes back', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('origin-checkin');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);

    const first = await upload(world, world.mario, id, hash, jpeg);
    expect(first.status).toBe(201);
    expect(first.json()).toMatchObject({ sha256: hash, kind: 'checkin', duplicated: false });

    // Idempotent retry: content-addressed, nothing changes.
    const again = await upload(world, world.mario, id, hash, jpeg);
    expect(again.status).toBe(200);
    expect(again.json()).toMatchObject({ duplicated: true });
    expect(await world.db.select().from(photos)).toHaveLength(1);

    // The listing links the photo to its custody event.
    const list = await world.api({
      method: 'GET',
      url: `/shipments/${id}/photos`,
      cookie: world.marco.cookie,
      expect: 200,
    });
    const listed = (list.json() as { photos: Record<string, unknown>[] }).photos;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ sha256: hash, kind: 'checkin', takenBy: world.mario.id });
    expect(listed[0]!.custodyEventId).not.toBeNull();

    // Sender and origin hub read back the EXACT certified bytes.
    for (const persona of [world.marco, world.mario]) {
      const res = await download(world, persona, id, hash);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.headers['cache-control']).toContain('private');
      expect(Buffer.from(res.rawPayload).equals(jpeg)).toBe(true);
    }
  });

  it('upload authz: non-parties 404, parties that are not the photographer 403', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('authz');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);

    // Luca has no leg yet: not a party — the shipment must not even exist
    // for him (404, not 403).
    expect((await upload(world, world.luca, id, hash, jpeg)).status).toBe(404);

    // Once his leg is accepted he IS a party… but still not the photographer.
    const tripId = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubC },
      expect: 201,
    });
    const asCarrier = await upload(world, world.luca, id, hash, jpeg);
    expect(asCarrier.status).toBe(403);
    expect(asCarrier.json()).toMatchObject({ error: 'photo_not_photographer' });

    // The sender is a party but did not certify this hash either.
    expect((await upload(world, world.marco, id, hash, jpeg)).status).toBe(403);
  });

  it('verifies bytes against the DECLARED hash and the certification record', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('declared');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);

    // Different bytes under a certified hash: the anchor holds.
    const forged = await upload(world, world.mario, id, hash, buildJpeg('other-bytes'));
    expect(forged.status).toBe(422);
    expect(forged.json()).toMatchObject({ error: 'photo_hash_mismatch' });

    // A hash never certified in the chain is not uploadable at all.
    const stray = buildJpeg('never-declared');
    const notCertified = await upload(world, world.mario, id, sha256Hex(stray), stray);
    expect(notCertified.status).toBe(422);
    expect(notCertified.json()).toMatchObject({ error: 'photo_not_certified' });

    // Nothing landed in the store or the table.
    expect(await world.db.select().from(photos)).toHaveLength(0);
  });

  it('format guards: JPEG whitelist by magic bytes, GPS EXIF refused, size capped', async () => {
    const world = await createLifecycleWorld();
    const gpsJpeg = buildJpegWithExif({ gps: true, label: 'gps' });
    const cleanExifJpeg = buildJpegWithExif({ gps: false, label: 'clean' });
    const png = Buffer.concat([PNG_MAGIC, Buffer.from('png-body')]);
    const hashes = [sha256Hex(gpsJpeg), sha256Hex(cleanExifJpeg), sha256Hex(png)];
    const { id } = await createWithPhotos(world, hashes);

    const asPng = await upload(world, world.mario, id, sha256Hex(png), png);
    expect(asPng.status).toBe(422);
    expect(asPng.json()).toMatchObject({ error: 'photo_format_unsupported' });

    const withGps = await upload(world, world.mario, id, sha256Hex(gpsJpeg), gpsJpeg);
    expect(withGps.status).toBe(422);
    expect(withGps.json()).toMatchObject({ error: 'photo_exif_gps' });

    // EXIF without GPS is fine: the guard targets geodata, not metadata per se.
    expect((await upload(world, world.mario, id, sha256Hex(cleanExifJpeg), cleanExifJpeg)).status).toBe(201);

    // Over the cap: refused while parsing, nothing reaches the guards.
    const oversize = Buffer.concat([buildJpeg('big'), Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect((await upload(world, world.mario, id, sha256Hex(oversize), oversize)).status).toBe(413);
  });

  it('checkout photos upload during the pending double confirmation (no event yet)', async () => {
    const world = await createLifecycleWorld();
    const checkinJpeg = buildJpeg('checkin');
    const checkoutJpeg = buildJpeg('checkout');
    const checkoutHash = sha256Hex(checkoutJpeg);
    const { id, qrToken } = await createWithPhotos(world, [sha256Hex(checkinJpeg)]);

    const tripId = await declareTrip(world, world.luca, -5, 50);
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/legs`,
      cookie: world.luca.cookie,
      body: { tripId, toHubId: world.hubC },
      expect: 201,
    });
    world.clock.advanceMinutes(1);
    await pumpWalletEvents(world.app.lifecycle);

    // Hub half of the double confirmation: hashes live on the leg row only.
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/pickup-checkout`,
      cookie: world.mario.cookie,
      body: { qrToken, photoSha256: [checkoutHash] },
      expect: 200,
    });

    // The hub can already upload; the row is not linked to any event yet.
    const pending = await upload(world, world.mario, id, checkoutHash, checkoutJpeg);
    expect(pending.status).toBe(201);
    expect(pending.json()).toMatchObject({ kind: 'checkout' });
    const [row] = await world.db.select().from(photos);
    expect(row!.custodyEventId).toBeNull();

    // The carrier is a party (may view) but NOT the checkout photographer.
    expect((await upload(world, world.luca, id, checkoutHash, checkoutJpeg)).status).toBe(403);
    const res = await download(world, world.luca, id, checkoutHash);
    expect(res.statusCode).toBe(200);
  });

  it('the recipient sees photos only AFTER claiming (ADR-016 gating)', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('for-rita');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);
    await upload(world, world.mario, id, hash, jpeg);

    // Before the claim Rita is not a participant: list and bytes are 404.
    expect((await download(world, world.rita, id, hash)).statusCode).toBe(404);
    await world.api({
      method: 'GET',
      url: `/shipments/${id}/photos`,
      cookie: world.rita.cookie,
      expect: 404,
    });

    const outbox = (await world.db.select().from(emailOutbox)).filter(
      (r) => r.template === 'parcel_tracking',
    );
    const claimToken = (outbox.at(-1)!.payload as { claimToken: string }).claimToken;
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/claim`,
      cookie: world.rita.cookie,
      body: { claimToken },
      expect: 201,
    });

    expect((await download(world, world.rita, id, hash)).statusCode).toBe(200);
  });

  it('unauthenticated and unrelated users never learn the shipment exists', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('private');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);
    await upload(world, world.mario, id, hash, jpeg);

    // No session at all.
    const anonymous = await world.app.inject({
      method: 'GET',
      url: `/shipments/${id}/photos/${hash}`,
    });
    expect(anonymous.statusCode).toBe(401);

    // Bruno owns hub B (the destination): he IS a party. Anna is not.
    expect((await download(world, world.bruno, id, hash)).statusCode).toBe(200);
    expect((await download(world, world.anna, id, hash)).statusCode).toBe(404);
    await world.api({
      method: 'GET',
      url: `/shipments/${id}/photos`,
      cookie: world.anna.cookie,
      expect: 404,
    });
  });

  it('GDPR erasure: closed-shipment photos die with the account, in-flight ones survive', async () => {
    const world = await createLifecycleWorld();
    const jpeg = buildJpeg('gdpr');
    const hash = sha256Hex(jpeg);
    const { id } = await createWithPhotos(world, [hash]);
    await upload(world, world.mario, id, hash, jpeg);

    // Shipment still AT_HUB: deleting Mario's account must NOT destroy the
    // counterparties' documentary evidence of the ongoing custody.
    await world.api({ method: 'DELETE', url: '/me', cookie: world.mario.cookie, expect: 200 });
    expect(await world.db.select().from(photos)).toHaveLength(1);
    expect(await world.app.blobStore.get(hash)).not.toBeNull();

    // Once the shipment closes, a fresh deletion request purges them.
    // (Mario's session died with the account: Marco cancels, then we run the
    // deletion path directly — the route is a thin wrapper over it.)
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/cancel`,
      cookie: world.marco.cookie,
      expect: 200,
    });
    const { deleteAccount } = await import('../lib/account');
    await deleteAccount(world.db, world.mario.id, world.app.blobStore);
    expect(await world.db.select().from(photos)).toHaveLength(0);
    expect(await world.app.blobStore.get(hash)).toBeNull();
  });
});
