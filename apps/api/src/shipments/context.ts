// ShipmentContext builder (ARCHITECTURE.md §5, "Precisazioni implementative").
//
// The pure state machine receives a snapshot of the aggregate; this module
// assembles it from database rows. Two reconstructions deserve a note:
//
//  - The WORK POOL of the current price segment is `shipments.segment_work_msat`
//    (frozen at creation and re-frozen by every reroute) plus the `boosted`
//    custody events SINCE the last `rerouted` event — exactly the closed form
//    of ECONOMICS.md §6 ("chiunque può ricalcolare il pool dalla riga della
//    spedizione più gli eventi di boost").
//  - The finalization-bonus QUOTAS have no columns by design (ADR-014,
//    precisazione 8): they accrue from the offer plus every boost, and the
//    carrier share stops counting once consumed by a first arrival at the
//    destination (`arrived_destination` in the chain).
//
// The custody chain is ordered by FOLLOWING THE HASH LINKS, not by timestamp:
// two events can share a millisecond, the chain cannot lie about order.

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@mercurio/db';
import {
  conditionalPayments,
  custodyEvents,
  hubs,
  hubStays,
  legs,
  shipmentClaims,
  shipments,
  users,
  walletConnections,
} from '@mercurio/db';
import { remainingPool, splitCommitment } from '@mercurio/core';
import type {
  ActiveHubStay,
  ActiveLeg,
  Msat,
  PendingClaim,
  PendingLegRequest,
  PoolBoost,
  ShipmentContext,
  ShipmentState,
} from '@mercurio/shared';
import { hubFeePercentToBp } from '@mercurio/shared';

export type ShipmentRow = typeof shipments.$inferSelect;
export type LegRow = typeof legs.$inferSelect;
export type HubStayRow = typeof hubStays.$inferSelect;
export type HubRow = typeof hubs.$inferSelect;
export type CustodyEventRow = typeof custodyEvents.$inferSelect;
export type ConditionalPaymentRow = typeof conditionalPayments.$inferSelect;
export type ShipmentClaimRow = typeof shipmentClaims.$inferSelect;

// ---------------------------------------------------------------------------
// Status mapping: Postgres enum (lowercase) ↔ machine states (UPPER_CASE)

export function dbStatusToState(status: ShipmentRow['status']): ShipmentState {
  return status.toUpperCase() as ShipmentState;
}

export function stateToDbStatus(state: ShipmentState): ShipmentRow['status'] {
  return state.toLowerCase() as ShipmentRow['status'];
}

// ---------------------------------------------------------------------------
// Custody-chain helpers

/** Order chain rows by following prev_event_hash links from the genesis row.
 *  Throws on a broken chain: a shipment whose history cannot be linearized
 *  must fail loudly, not be interpreted. */
export function orderCustodyChain(rows: readonly CustodyEventRow[]): CustodyEventRow[] {
  if (rows.length === 0) return [];
  const byPrev = new Map<string | null, CustodyEventRow>();
  for (const row of rows) {
    if (byPrev.has(row.prevEventHash)) {
      throw new Error(`custody chain fork at prev=${row.prevEventHash ?? 'genesis'}`);
    }
    byPrev.set(row.prevEventHash, row);
  }
  const ordered: CustodyEventRow[] = [];
  let cursor = byPrev.get(null);
  while (cursor) {
    ordered.push(cursor);
    cursor = byPrev.get(cursor.hash);
  }
  if (ordered.length !== rows.length) {
    throw new Error(`custody chain broken: linked ${ordered.length} of ${rows.length} events`);
  }
  return ordered;
}

interface BoostPayload {
  amountMsat: Msat;
  atRemainingKm: number;
}

function parseBoostPayload(payload: unknown): BoostPayload {
  const p = payload as { amountMsat?: unknown; atRemainingKm?: unknown };
  const raw = p.amountMsat;
  // Stored canonically as a decimal string (canonicalJson renders bigint so);
  // accept a number defensively for hand-seeded rows.
  const amountMsat =
    typeof raw === 'string' ? BigInt(raw) : typeof raw === 'number' ? BigInt(raw) : null;
  const atRemainingKm = typeof p.atRemainingKm === 'number' ? p.atRemainingKm : null;
  if (amountMsat === null || amountMsat <= 0n || atRemainingKm === null || atRemainingKm <= 0) {
    throw new Error(`malformed boosted payload: ${JSON.stringify(payload)}`);
  }
  return { amountMsat, atRemainingKm };
}

// ---------------------------------------------------------------------------
// The bundle

export interface ShipmentBundle {
  shipment: ShipmentRow;
  state: ShipmentState;
  ctx: ShipmentContext;
  /** The stay backing ctx.currentHubStay (null while IN_TRANSIT/terminal). */
  currentStayRow: HubStayRow | null;
  /** The pending/booked/picked-up leg, if any. */
  activeLegRow: LegRow | null;
  /** The leg in status 'requested' (ADR-029), if any: a deposit request the
   *  arrival hub has not answered yet. NEVER an active leg — no conditional
   *  payment exists for it. */
  requestedLegRow: LegRow | null;
  /** The reserved stay at the active leg's arrival hub, if any. */
  arrivalStayRow: HubStayRow | null;
  /** The pending Π_h hold row of a final LEG (purpose finalization_bonus,
   *  created|held, ref NOT 'claim' — a claim's bonus hold lives with the
   *  claim, ADR-016). */
  bonusHoldRow: ConditionalPaymentRow | null;
  /** The live recipient claim (status pending_funding|funded), if any. */
  pendingClaimRow: ShipmentClaimRow | null;
  /** Every hub referenced by the shipment/stays/legs, by id. */
  hubById: Map<string, HubRow>;
  senderEmail: string;
  /** Full chain in link order (used for replay and for the detail view). */
  chain: CustodyEventRow[];
  /** Boosts of the CURRENT price segment, as the economics engine wants them. */
  segmentBoosts: PoolBoost[];
  /** Accrued carrier quota Π_v still available (0n once consumed). */
  carrierBonusAvailableMsat: Msat;
  /** Accrued destination-hub quota Π_h (consumed only at delivery). */
  hubBonusAvailableMsat: Msat;
}

/** Remaining work pool with the parcel `remainingKm` from the destination
 *  (notional accounting — nothing is prefunded, ADR-013). */
export function remainingWorkPool(bundle: ShipmentBundle, remainingKm: number): Msat {
  return remainingPool(
    bundle.shipment.segmentWorkMsat,
    bundle.shipment.distanceKm,
    remainingKm,
    bundle.segmentBoosts,
  );
}

const EPOCH_ISO = new Date(0).toISOString();

export interface LoadBundleOptions {
  forUpdate?: boolean;
  /** Conditional payments minted by the very transition being executed:
   *  the executor's in-transaction recompute must see the world as it was
   *  BEFORE them (a final leg_accept would otherwise trip over its own
   *  freshly-created Π_h hold). */
  ignorePaymentIds?: ReadonlySet<string>;
}

export async function loadShipmentBundle(
  db: Db,
  shipmentId: string,
  opts: LoadBundleOptions = {},
): Promise<ShipmentBundle | null> {
  // The row lock serializes transitions per shipment: everything after this
  // read (chain tail, seq counters, status flip) is race-free by construction.
  const shipmentQuery = db.select().from(shipments).where(eq(shipments.id, shipmentId));
  const [shipment] = opts.forUpdate ? await shipmentQuery.for('update') : await shipmentQuery;
  if (!shipment) return null;

  const [stays, shipmentLegs, chainRows, bonusRows, claimRows, senderRows, senderWallets] =
    await Promise.all([
      db.select().from(hubStays).where(eq(hubStays.shipmentId, shipmentId)),
      db.select().from(legs).where(eq(legs.shipmentId, shipmentId)),
      db.select().from(custodyEvents).where(eq(custodyEvents.shipmentId, shipmentId)),
      db
        .select()
        .from(conditionalPayments)
        .where(eq(conditionalPayments.shipmentId, shipmentId)),
      db.select().from(shipmentClaims).where(eq(shipmentClaims.shipmentId, shipmentId)),
      db.select({ email: users.email }).from(users).where(eq(users.id, shipment.senderId)),
      db
        .select({ id: walletConnections.id })
        .from(walletConnections)
        .where(
          and(
            eq(walletConnections.userId, shipment.senderId),
            eq(walletConnections.status, 'connected'),
          ),
        ),
    ]);

  const state = dbStatusToState(shipment.status);
  const chain = orderCustodyChain(chainRows);

  // --- hubs referenced anywhere in the aggregate
  const hubIds = new Set<string>([shipment.originHubId, shipment.destHubId]);
  for (const stay of stays) hubIds.add(stay.hubId);
  for (const leg of shipmentLegs) {
    hubIds.add(leg.fromHubId);
    hubIds.add(leg.toHubId);
  }
  const hubRows = await db
    .select()
    .from(hubs)
    .where(inArray(hubs.id, [...hubIds]));
  const hubById = new Map(hubRows.map((h) => [h.id, h]));
  const mustHub = (id: string): HubRow => {
    const hub = hubById.get(id);
    if (!hub) throw new Error(`shipment ${shipmentId} references missing hub ${id}`);
    return hub;
  };

  // --- current stay / active leg / arrival stay
  const bySeq = [...stays].sort((a, b) => a.seq - b.seq);
  const activeStay = bySeq.filter((s) => s.status === 'active').at(-1) ?? null;
  const reservedStay = bySeq.filter((s) => s.status === 'reserved').at(-1) ?? null;
  const activeLegRow =
    shipmentLegs.find((l) => ['pending_funding', 'booked', 'picked_up'].includes(l.status)) ??
    null;
  // A 'requested' leg (ADR-029) is NOT active: no holds, no arrival stay yet.
  // At most one exists (leg_request is barred while one is pending).
  const requestedLegRow = shipmentLegs.find((l) => l.status === 'requested') ?? null;
  // With a leg in flight the reserved stay is its arrival reservation; the
  // only other reserved stay ever is the origin one in AWAITING_DROPOFF.
  const arrivalStayRow = activeLegRow ? reservedStay : null;

  let currentStayRow: HubStayRow | null = null;
  switch (state) {
    case 'AWAITING_DROPOFF':
      currentStayRow = reservedStay;
      break;
    case 'AT_HUB':
    case 'LEG_BOOKED':
    case 'AWAITING_PICKUP':
    case 'CLAIMED': // the claim never moves the parcel: same custodian hub
      currentStayRow = activeStay;
      break;
    default:
      currentStayRow = null; // DRAFT, IN_TRANSIT (carrier is custodian), terminal
  }

  const currentHubStay: ActiveHubStay | null = currentStayRow
    ? {
        hubStayId: currentStayRow.id,
        hubId: currentStayRow.hubId,
        hubUserId: mustHub(currentStayRow.hubId).userId,
        // Non-null from origin_hub_accept on (the transition creates the hold
        // before the row is written); assert instead of silently passing ''.
        bondPaymentId: mustBondId(currentStayRow),
        // Reserved stays have no deadline yet (it starts at check-in); the
        // machine never reads it in those states — epoch is a safe sentinel.
        storageDeadlineAt: currentStayRow.storageDeadlineAt?.toISOString() ?? EPOCH_ISO,
      }
    : null;

  let leg: ActiveLeg | null = null;
  if (activeLegRow) {
    if (!arrivalStayRow) {
      throw new Error(`leg ${activeLegRow.id} has no reserved arrival stay`);
    }
    leg = {
      legId: activeLegRow.id,
      carrierId: activeLegRow.carrierId,
      fromHubId: activeLegRow.fromHubId,
      fromHubUserId: mustHub(activeLegRow.fromHubId).userId,
      toHubId: activeLegRow.toHubId,
      toHubUserId: mustHub(activeLegRow.toHubId).userId,
      arrivalHubStayId: arrivalStayRow.id,
      pricing: {
        grossMsat: activeLegRow.grossMsat,
        depHubFeeMsat: activeLegRow.depHubFeeMsat,
        arrHubFeeMsat: activeLegRow.arrHubFeeMsat,
        netMsat: activeLegRow.netMsat,
        finalizationBonusMsat: activeLegRow.finalizationBonusMsat,
      },
      legPaymentId: mustCpId(activeLegRow.paymentConditionalPaymentId, activeLegRow.id, 'payment'),
      carrierBondId: mustCpId(activeLegRow.bondConditionalPaymentId, activeLegRow.id, 'bond'),
      arrivalHubBondId: mustBondId(arrivalStayRow),
      fundingDeadlineAt: mustFundingDeadline(activeLegRow),
      pickupDeadlineAt: activeLegRow.pickupDeadlineAt?.toISOString() ?? null,
      transitDeadlineAt: activeLegRow.transitDeadlineAt?.toISOString() ?? null,
    };
  }

  // --- pending deposit request (ADR-029): the frozen Π_h share lives in the
  // deposit_requested chain payload — the chain is its only store, like the
  // quota accumulators (boost/reroute are barred while a request is pending,
  // so nothing can shift under the frozen value).
  let pendingLegRequest: PendingLegRequest | null = null;
  if (requestedLegRow) {
    if (!requestedLegRow.responseDeadlineAt) {
      throw new Error(`requested leg ${requestedLegRow.id} has no response deadline`);
    }
    pendingLegRequest = {
      legId: requestedLegRow.id,
      carrierId: requestedLegRow.carrierId,
      fromHubId: requestedLegRow.fromHubId,
      fromHubUserId: mustHub(requestedLegRow.fromHubId).userId,
      toHubId: requestedLegRow.toHubId,
      toHubUserId: mustHub(requestedLegRow.toHubId).userId,
      pricing: {
        grossMsat: requestedLegRow.grossMsat,
        depHubFeeMsat: requestedLegRow.depHubFeeMsat,
        arrHubFeeMsat: requestedLegRow.arrHubFeeMsat,
        netMsat: requestedLegRow.netMsat,
        finalizationBonusMsat: requestedLegRow.finalizationBonusMsat,
      },
      finalizationHubBonusMsat: requestedHubBonus(chain, requestedLegRow.id),
      responseDeadlineAt: requestedLegRow.responseDeadlineAt.toISOString(),
    };
  }

  // --- pending Π_h hold (ADR-014: purpose finalization_bonus, created|held).
  // Claim-referenced bonus holds are excluded: they belong to pendingClaim
  // (ADR-016) and must never alias ctx.finalizationBonusHold.
  const bonusHoldRow =
    bonusRows.find(
      (p) =>
        p.purpose === 'finalization_bonus' &&
        p.refType !== 'claim' &&
        (p.state === 'created' || p.state === 'held') &&
        !opts.ignorePaymentIds?.has(p.id),
    ) ?? null;

  // --- live recipient claim (ADR-016): at most one by machine guard + index.
  const pendingClaimRow =
    claimRows.find((c) => c.status === 'pending_funding' || c.status === 'funded') ?? null;
  const pendingClaim: PendingClaim | null = pendingClaimRow
    ? {
        claimId: pendingClaimRow.id,
        claimantId: pendingClaimRow.claimantId,
        hubStayId: pendingClaimRow.hubStayId,
        claimPaymentMsat: pendingClaimRow.claimPaymentMsat,
        hubBonusMsat: pendingClaimRow.hubBonusMsat,
        claimPaymentId: mustClaimCpId(pendingClaimRow),
        hubBonusPaymentId: pendingClaimRow.hubBonusConditionalPaymentId,
        fundingDeadlineAt: pendingClaimRow.fundingDeadlineAt.toISOString(),
      }
    : null;

  // --- ADR-014 accumulators + current-segment boosts from the chain
  const offerSplit = splitCommitment(shipment.offerMsat);
  let carrierBonus = offerSplit.carrierBonusMsat;
  let hubBonus = offerSplit.hubBonusMsat;
  const carrierConsumed = chain.some((e) => e.type === 'arrived_destination');
  const segmentBoosts: PoolBoost[] = [];
  for (const event of chain) {
    if (event.type === 'rerouted') {
      // The reroute froze everything so far into segment_work_msat; boosts
      // relative to the previous segment must not be replayed onto this one.
      segmentBoosts.length = 0;
    } else if (event.type === 'boosted') {
      const boost = parseBoostPayload(event.payload);
      const split = splitCommitment(boost.amountMsat);
      segmentBoosts.push({ amountMsat: split.workMsat, atRemainingKm: boost.atRemainingKm });
      // Quotas accrue per shipment, not per segment (ADR-014 precisazione 2):
      // the carrier share stops accruing once consumed — every boost that can
      // exist before consumption IS before it, so summing all is exact.
      carrierBonus += split.carrierBonusMsat;
      hubBonus += split.hubBonusMsat;
    }
  }
  const carrierBonusAvailableMsat = carrierConsumed ? 0n : carrierBonus;

  const originHub = mustHub(shipment.originHubId);
  const ctx: ShipmentContext = {
    shipmentId: shipment.id,
    senderId: shipment.senderId,
    senderWalletConnected: senderWallets.length > 0,
    originHubId: shipment.originHubId,
    originHubUserId: originHub.userId,
    destHubId: shipment.destHubId,
    custodyBondMsat: shipment.custodyBondMsat,
    offerMsat: shipment.offerMsat,
    workCommitmentMsat: shipment.segmentWorkMsat,
    originHubFeeBp: hubFeePercentToBp(originHub.feePercent),
    currentHubStay,
    leg,
    finalizationBonusHold: bonusHoldRow
      ? { paymentId: bonusHoldRow.id, amountMsat: bonusHoldRow.amountMsat }
      : null,
    pendingClaim,
    pendingLegRequest,
  };

  return {
    shipment,
    state,
    ctx,
    currentStayRow,
    activeLegRow,
    requestedLegRow,
    arrivalStayRow,
    bonusHoldRow,
    pendingClaimRow,
    hubById,
    senderEmail: senderRows[0]?.email ?? '',
    chain,
    segmentBoosts,
    carrierBonusAvailableMsat,
    hubBonusAvailableMsat: hubBonus,
  };
}

function mustBondId(stay: HubStayRow): string {
  if (!stay.bondConditionalPaymentId) {
    throw new Error(`hub stay ${stay.id} has no bond conditional payment`);
  }
  return stay.bondConditionalPaymentId;
}

function mustCpId(id: string | null, legId: string, which: string): string {
  if (!id) throw new Error(`leg ${legId} has no ${which} conditional payment`);
  return id;
}

function mustClaimCpId(claim: ShipmentClaimRow): string {
  if (!claim.paymentConditionalPaymentId) {
    throw new Error(`claim ${claim.id} has no claim-payment conditional payment`);
  }
  return claim.paymentConditionalPaymentId;
}

/** Every leg past 'requested' has a funding window (deposit_accept set it);
 *  nullable only for the ADR-029 request phase, which never builds ActiveLeg. */
function mustFundingDeadline(leg: LegRow): string {
  if (!leg.fundingDeadlineAt) {
    throw new Error(`leg ${leg.id} in status ${leg.status} has no funding deadline`);
  }
  return leg.fundingDeadlineAt.toISOString();
}

/** The frozen Π_h of a requested leg, read back from its deposit_requested
 *  chain event (canonical payload: bigints are decimal strings). */
function requestedHubBonus(chain: readonly CustodyEventRow[], legId: string): Msat {
  for (const event of chain) {
    if (event.type !== 'deposit_requested' || event.legId !== legId) continue;
    const raw = (event.payload as { finalizationHubBonusMsat?: string | number })
      .finalizationHubBonusMsat;
    if (typeof raw === 'string' || typeof raw === 'number') return BigInt(raw);
    throw new Error(`deposit_requested event for leg ${legId} has a malformed hub-bonus payload`);
  }
  throw new Error(`requested leg ${legId} has no deposit_requested chain event`);
}
