// Wallet-event pump (ESCROW.md §5): one observation sweep over unresolved
// conditional payments, then the funding check — a leg books (`leg_funded`)
// only when EVERY hold of its funding window is observed held at the payee
// wallets: the three of ESCROW §3 plus, on a final leg, the Π_h hold
// (ADR-014: four with the hub bonus, three when it floored to zero and was
// never created).
//
// The pump never decides amounts and never moves money by itself: it turns
// wallet observations into machine events, and the machine rejects anything
// stale (funding window expired, leg already booked) — rejections are benign.

import { inArray } from 'drizzle-orm';
import { conditionalPayments } from '@mercurio/db';
import type { CoordinatorEvent } from '@mercurio/escrow';
import { PICKUP_WINDOW_HOURS } from '@mercurio/shared';
import { loadShipmentBundle } from './context';
import { executeShipmentTransition, type LifecycleDeps } from './executor';
import { ConflictError, TransitionRejectedError } from './errors';

export interface PumpResult {
  observed: CoordinatorEvent[];
  /** Shipments whose pending leg reached LEG_BOOKED in this pass. */
  funded: string[];
}

export async function pumpWalletEvents(deps: LifecycleDeps): Promise<PumpResult> {
  const observed = await deps.coordinator.pollOnce();
  const candidates = new Set(
    observed.filter((e) => e.type === 'payment_held').map((e) => e.shipmentId),
  );
  const funded: string[] = [];
  for (const shipmentId of candidates) {
    if (await tryCompleteLegFunding(deps, shipmentId)) funded.push(shipmentId);
  }
  return { observed, funded };
}

/** Idempotent: safe to call at any time for any shipment (a second call, or
 *  a shipment with nothing pending, is a no-op). */
export async function tryCompleteLegFunding(
  deps: LifecycleDeps,
  shipmentId: string,
): Promise<boolean> {
  const bundle = await loadShipmentBundle(deps.db, shipmentId);
  if (!bundle || bundle.state !== 'AT_HUB') return false;
  const leg = bundle.ctx.leg;
  if (!leg || bundle.activeLegRow?.status !== 'pending_funding') return false;

  const requiredIds = [leg.legPaymentId, leg.carrierBondId, leg.arrivalHubBondId];
  if (bundle.ctx.finalizationBonusHold) requiredIds.push(bundle.ctx.finalizationBonusHold.paymentId);
  const rows = await deps.db
    .select({ id: conditionalPayments.id, state: conditionalPayments.state })
    .from(conditionalPayments)
    .where(inArray(conditionalPayments.id, requiredIds));
  const held = new Map(rows.map((r) => [r.id, r.state]));
  if (requiredIds.some((id) => held.get(id) !== 'held')) return false;

  const now = deps.now();
  const pickupDeadline = new Date(now.getTime() + PICKUP_WINDOW_HOURS * 60 * 60 * 1000);
  try {
    await executeShipmentTransition(deps, {
      shipmentId,
      event: {
        type: 'leg_funded',
        now: now.toISOString(),
        pickupDeadlineAt: pickupDeadline.toISOString(),
      },
    });
    return true;
  } catch (err) {
    if (err instanceof TransitionRejectedError || err instanceof ConflictError) {
      // Window expired or a concurrent pump won: the timers/other pass will
      // settle the aggregate — nothing to do here.
      return false;
    }
    throw err;
  }
}
