// Physical acceptance checks a hub imposes on a parcel (ARCHITECTURE.md §4).
// Mirrors the matching engine's candidate condition 1 (rotation allowed:
// compare sorted triples) so the board and the API can never disagree.

import type { hubs } from '@mercurio/db';

export interface ParcelShape {
  dimLCm: number;
  dimWCm: number;
  dimHCm: number;
  weightG: number;
  undeclared: boolean;
}

type HubRow = typeof hubs.$inferSelect;

export function parcelFitsHub(parcel: ParcelShape, hub: HubRow): string | null {
  const sides = [parcel.dimLCm, parcel.dimWCm, parcel.dimHCm].sort((a, b) => a - b);
  const limits = [hub.maxDimCmL, hub.maxDimCmW, hub.maxDimCmH].sort((a, b) => a - b);
  if (sides.some((side, i) => side > (limits[i] ?? 0))) return 'parcel_too_big';
  if (parcel.weightG > hub.maxWeightG) return 'parcel_too_heavy';
  if (parcel.undeclared && !hub.acceptsUndeclared) return 'undeclared_not_accepted';
  return null;
}

/** The stay the shipment would open at this hub must fit the hub's own
 *  storage ceiling — a shorter ceiling would forfeit the parcel earlier than
 *  the sender agreed to (never silently shrink the sender's window). */
export function storageFitsHub(maxStorageHours: number, hub: HubRow): string | null {
  return maxStorageHours <= hub.maxStorageHours ? null : 'hub_storage_too_short';
}
