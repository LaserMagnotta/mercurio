// Shipment codename minting (Fase 1 punto 1). The generator is pure and lives
// in @mercurio/core; the DB probe lives here because it needs I/O.
//
// The unique index on shipments.codename is the real guarantee of uniqueness
// (it closes the check-then-insert race two concurrent creations would open).
// This probe just keeps the insert from failing on a collision that was
// already visible: at MVP volumes against ~1.4M combinations it almost never
// finds one, so the loop almost always runs exactly once.

import { eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { shipments } from '@mercurio/db';
import { generateCodename } from '@mercurio/core';

/** How many free-codename probes before giving up. Each miss is astronomically
 *  unlikely at MVP volumes, so a handful is already generous; the ceiling only
 *  exists so a pathologically full table surfaces a clean error instead of
 *  looping forever. */
const MAX_ATTEMPTS = 8;

export class CodenameExhaustedError extends Error {
  constructor() {
    super('could not mint a free shipment codename');
    this.name = 'CodenameExhaustedError';
  }
}

/**
 * Return a codename not currently used by any shipment. Throws
 * CodenameExhaustedError after MAX_ATTEMPTS collisions (never in practice).
 *
 * `random` is injectable so a test can force collisions deterministically.
 */
export async function mintCodename(db: Db, random?: () => number): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = generateCodename(random);
    const [existing] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.codename, candidate))
      .limit(1);
    if (!existing) return candidate;
  }
  throw new CodenameExhaustedError();
}
