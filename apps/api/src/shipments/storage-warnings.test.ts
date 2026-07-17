// Storage-expiry warnings (RISKS.md §4, ToS §10.1): the sweep warns sender
// and recipient at the 72h/24h thresholds of the ARMED storage timer, is
// idempotent per (stay, threshold, audience), and goes silent the moment the
// timer is disarmed or fired. Same world as the lifecycle suites.

import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emailOutbox, shipmentTimers } from '@mercurio/db';
import {
  CANONICAL_CREATE_BODY,
  createLifecycleWorld,
  createShipmentAtHub,
  type LifecycleWorld,
} from './test-world';
import { enqueueStorageWarnings } from './storage-warnings';
import { dispatchEmailOutbox } from './outbox';

describe('storage-expiry warnings', () => {
  let world: LifecycleWorld;

  beforeEach(async () => {
    world = await createLifecycleWorld();
  });

  const deps = () => ({ db: world.db, now: () => new Date(world.clock.nowMs) });

  const warningRows = async () =>
    world.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.template, 'storage_expiry_warning'));

  it('warns sender and recipient at 72h, then again at 24h, idempotently', async () => {
    await createShipmentAtHub(world); // storage = 72h from check-in

    // 2h into a 72h stay: 70h remain, inside the 72h threshold.
    world.clock.advanceHours(2);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(2);
    let rows = await warningRows();
    expect(rows.map((r) => [r.to, (r.payload as { threshold: string }).threshold]).sort()).toEqual(
      [
        ['destinataria@test.local', '72'],
        ['marco@test.local', '72'],
      ],
    );

    // Same threshold, later sweep: nothing new.
    world.clock.advanceHours(10);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(0);

    // 20h remain: the 24h rung fires once for each audience.
    world.clock.advanceHours(40);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(2);
    rows = await warningRows();
    expect(rows).toHaveLength(4);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(0);

    // Past the deadline the timer is due, not upcoming: the sweep is silent
    // (storage_expiry itself is the timer sweep's job, not ours).
    world.clock.advanceHours(30);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(0);
  });

  it('a stay already inside the last threshold gets ONE catch-up warning per audience', async () => {
    const created = await world.api({
      method: 'POST',
      url: '/shipments',
      cookie: world.marco.cookie,
      body: {
        ...CANONICAL_CREATE_BODY,
        maxStorageHours: 12, // shorter than the 24h rung
        originHubId: world.hubA,
        destHubId: world.hubB,
      },
      expect: 201,
    });
    const { id, qrToken } = created.json() as { id: string; qrToken: string };
    await world.api({
      method: 'POST',
      url: `/shipments/${id}/origin-checkin`,
      cookie: world.mario.cookie,
      body: { qrToken, photoSha256: ['a'.repeat(64)] },
      expect: 200,
    });

    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(2);
    const rows = await warningRows();
    // Most urgent rung only: no 72h + 24h double email in the same sweep.
    expect(rows.map((r) => (r.payload as { threshold: string }).threshold)).toEqual(['24', '24']);
  });

  it('a disarmed timer (parcel booked or gone) produces no warning', async () => {
    const { id } = await createShipmentAtHub(world);
    // Simulate the leg_funded disarm the executor performs (cancel_timeout
    // deletes the row): with no armed timer there is nothing to warn about.
    await world.db
      .delete(shipmentTimers)
      .where(and(eq(shipmentTimers.shipmentId, id), eq(shipmentTimers.kind, 'storage')));

    world.clock.advanceHours(50);
    expect((await enqueueStorageWarnings(deps())).enqueued).toBe(0);
  });

  it('renders with the ToS/privacy links and the audience-specific action', async () => {
    await createShipmentAtHub(world);
    world.clock.advanceHours(50); // 22h remain → the 24h rung
    await enqueueStorageWarnings(deps());
    await dispatchEmailOutbox({
      db: world.db,
      sendMail: async (mail) => {
        world.sentEmails.push(mail);
      },
      now: () => new Date(world.clock.nowMs),
    });

    const warnings = world.sentEmails.filter((m) => m.subject.includes('giacenza in scadenza'));
    expect(warnings).toHaveLength(2);
    const sender = warnings.find((m) => m.to === 'marco@test.local')!;
    const recipient = warnings.find((m) => m.to === 'destinataria@test.local')!;
    for (const mail of [sender, recipient]) {
      expect(mail.text).toContain('/tos');
      expect(mail.text).toContain('/privacy'); // art. 21 objection link (RISKS §6)
      expect(mail.text).toContain('Hub A');
    }
    expect(sender.text).toContain('/shipments/');
    expect(recipient.text).toContain('/track/');
  });

  it('the tracking email carries the art. 14 first-contact notice', async () => {
    await createShipmentAtHub(world);
    await dispatchEmailOutbox({
      db: world.db,
      sendMail: async (mail) => {
        world.sentEmails.push(mail);
      },
      now: () => new Date(world.clock.nowMs),
    });
    const tracking = world.sentEmails.find((m) => m.subject.includes('codice personale'))!;
    expect(tracking.to).toBe('destinataria@test.local');
    expect(tracking.text).toContain('art. 14 GDPR');
    expect(tracking.text).toContain('/privacy');
  });
});
