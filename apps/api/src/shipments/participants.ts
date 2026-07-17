// Who counts as a PARTY to a shipment (ADR-020 §4, same set as the
// GET /shipments/:id participant view): the sender, the owner of every hub
// referenced by the aggregate, the carrier of any leg, and anyone who filed
// a claim (ADR-016). Everyone else gets 404 — existence is never leaked.

import { eq } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import { legs, shipmentClaims } from '@mercurio/db';
import type { ShipmentBundle } from './context.js';

export async function isShipmentParticipant(
  db: Db,
  bundle: ShipmentBundle,
  userId: string,
): Promise<boolean> {
  if (bundle.shipment.senderId === userId) return true;
  for (const hub of bundle.hubById.values()) {
    if (hub.userId === userId) return true;
  }
  const legRows = await db
    .select({ carrierId: legs.carrierId })
    .from(legs)
    .where(eq(legs.shipmentId, bundle.shipment.id));
  if (legRows.some((l) => l.carrierId === userId)) return true;
  const claimRows = await db
    .select({ claimantId: shipmentClaims.claimantId })
    .from(shipmentClaims)
    .where(eq(shipmentClaims.shipmentId, bundle.shipment.id));
  return claimRows.some((c) => c.claimantId === userId);
}
