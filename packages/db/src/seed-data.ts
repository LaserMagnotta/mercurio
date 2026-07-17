import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { hubs, shipments, users } from './schema/index.js';

/**
 * Demo dataset: 3 users, 3 hubs, 1 shipment - mirrors the canonical example
 * in CLAUDE.md (Marco ships pens from a Bologna hub to a Firenze hub).
 *
 * Idempotent: safe to re-run (checked by email, the natural unique key),
 * matching the "docker compose up + setup" contract (task #6) - re-running
 * `pnpm setup` must not fail on a database that was already seeded.
 *
 * Amounts use a fixed demo EUR/sat rate (not a real market quote) - the
 * point is to exercise the schema end-to-end, not to be financially
 * accurate; see ADR-008 for how real quotes are sourced and frozen.
 */
export async function seedDemoData(db: Db) {
  const existing = await db.select().from(users).where(eq(users.email, 'marco@example.com'));
  if (existing.length > 0) {
    console.log('Demo data already present, skipping seed.');
    return;
  }

  const [marco] = await db
    .insert(users)
    .values({ email: 'marco@example.com', locale: 'it' })
    .returning();
  const [mario] = await db
    .insert(users)
    .values({ email: 'mario@example.com', locale: 'it' })
    .returning();
  const [giulia] = await db
    .insert(users)
    .values({ email: 'giulia@example.com', locale: 'it' })
    .returning();
  if (!marco || !mario || !giulia) throw new Error('seed: user insert failed');

  // Marco's own hub - unrelated to the demo shipment below, just populates
  // the board with a third hub (CLAUDE.md: a sender can also be a hub owner).
  const [hubMarco] = await db
    .insert(hubs)
    .values({
      userId: marco.id,
      name: 'Edicola Marco',
      address: 'Via Torino 12, Milano',
      lat: 45.4642,
      lng: 9.19,
      openingHours: { 'mon-sat': '07:00-20:00' },
      maxDimCmL: 60,
      maxDimCmW: 60,
      maxDimCmH: 60,
      maxWeightG: 20000,
      acceptsUndeclared: true,
      feePercent: '10.00',
      maxStorageHours: 72,
      autoAccept: true,
      active: true,
    })
    .returning();

  const [hubMario] = await db
    .insert(hubs)
    .values({
      userId: mario.id,
      name: 'Bar Mario',
      address: 'Via Zamboni 5, Bologna',
      lat: 44.4949,
      lng: 11.3426,
      openingHours: { 'mon-sat': '06:00-21:00' },
      maxDimCmL: 50,
      maxDimCmW: 50,
      maxDimCmH: 50,
      maxWeightG: 15000,
      acceptsUndeclared: true,
      feePercent: '10.00',
      maxStorageHours: 72,
      autoAccept: true,
      active: true,
    })
    .returning();

  const [hubGiulia] = await db
    .insert(hubs)
    .values({
      userId: giulia.id,
      name: 'Tabaccheria Giulia',
      address: "Via de' Tornabuoni 3, Firenze",
      lat: 43.7696,
      lng: 11.2558,
      openingHours: { 'mon-fri': '08:00-19:30', sat: '08:00-13:00' },
      maxDimCmL: 50,
      maxDimCmW: 50,
      maxDimCmH: 50,
      maxWeightG: 15000,
      acceptsUndeclared: false,
      feePercent: '10.00',
      maxStorageHours: 48,
      autoAccept: true,
      active: true,
    })
    .returning();

  if (!hubMarco || !hubMario || !hubGiulia) throw new Error('seed: hub insert failed');

  // The CLAUDE.md canonical example: Marco ships pens (value <= 45 EUR cap,
  // RISKS.md sec.2) from Mario's hub (Bologna) to Giulia's hub (Firenze).
  // Demo EUR/sat rate: 1 EUR = 1500 sat (illustrative only, ADR-008).
  const DEMO_SAT_PER_EUR = 1500n;
  const msatFor = (eur: bigint) => eur * DEMO_SAT_PER_EUR * 1000n;

  await db.insert(shipments).values({
    senderId: marco.id,
    originHubId: hubMario.id,
    destHubId: hubGiulia.id,
    recipientEmail: 'destinatario@example.com', // no account needed to receive (ADR-009)
    qrToken: randomUUID(),
    // A fixed demo codename (the canonical Marco→Giulia shipment); real ones
    // are minted server-side at POST /shipments (apps/api lib/codename.ts).
    codename: 'Tasso-Ambrato-742',
    dimLCm: 20,
    dimWCm: 15,
    dimHCm: 5,
    weightG: 200,
    declaredContent: 'penne',
    undeclared: false,
    offerMsat: msatFor(5n),
    custodyBondMsat: msatFor(15n),
    maxStorageHours: 48,
    eurRateSnapshot: DEMO_SAT_PER_EUR.toString(),
    eurRateSource: 'demo-seed',
    eurRateAt: new Date(),
    status: 'draft',
    distanceKm: 100, // matches the CLAUDE.md canonical example (haversine x 1.3, ADR-007)
  });

  console.log('Seeded 3 users, 3 hubs, 1 shipment.');
}
