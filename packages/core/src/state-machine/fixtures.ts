// Shared test fixtures for the state machine suites. One canonical shipment
// (the CLAUDE.md example: 5 € offer, 15 € bond, A → B via C) expressed in
// msat, with builders that produce a valid context/event for every state so
// both the exhaustive suite and the property walker start from the same
// ground truth. Not exported from the package (test-only).

import type {
  ActiveHubStay,
  ActiveLeg,
  FinalizationBonusHold,
  LegPricing,
  ShipmentContext,
  ShipmentEvent,
  ShipmentState,
} from '@mercurio/shared';

export const T0 = Date.parse('2026-07-12T08:00:00.000Z');

/** Minutes after T0 → ISO string; every deadline in the fixtures uses this. */
export const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();

export const IDS = {
  shipment: 'ship-1',
  sender: 'user-sender',
  originHubUser: 'user-hub-origin',
  intermediateHubUser: 'user-hub-c',
  destHubUser: 'user-hub-dest',
  carrier: 'user-carrier',
  originHub: 'hub-origin',
  intermediateHub: 'hub-c',
  destHub: 'hub-dest',
  originStay: 'stay-origin',
  arrivalStay: 'stay-arrival',
  returnStay: 'stay-return',
  leg: 'leg-1',
  legPayment: 'cp-leg-payment',
  carrierBond: 'cp-carrier-bond',
  arrivalHubBond: 'cp-arrival-hub-bond',
  originHubBond: 'cp-origin-hub-bond',
  finalizationBonus: 'cp-finalization-bonus',
} as const;

/** 5 € ≈ 8000 sats and 15 € ≈ 24000 sats at the frozen snapshot — the exact
 *  EUR rate is irrelevant to the machine, only bigint msat amounts matter. */
export const OFFER_MSAT = 8_000_000n;
export const BOND_MSAT = 24_000_000n;

/** ADR-014 split of the offer: work pool 90%, bonus quotas 7% / 3%. */
export const WORK_MSAT = 7_200_000n;
export const CARRIER_BONUS_MSAT = 560_000n;
export const HUB_BONUS_MSAT = 240_000n;

/** Leg A→C: 40 km of 100, hubs at 10% — the canonical example's first leg on
 *  the work pool (gross 40% of 7 200 000 = 2 880 000 msat, fees 288 000 each,
 *  net 2 304 000; no bonus: C is not the destination). */
export const PRICING: LegPricing = {
  grossMsat: 2_880_000n,
  depHubFeeMsat: 288_000n,
  arrHubFeeMsat: 288_000n,
  netMsat: 2_304_000n,
  finalizationBonusMsat: 0n,
};

/** Leg C→B: the final 60 km on the remaining work pool (gross 4 320 000 msat,
 *  fees 432 000 each, net 3 456 000) plus the carrier bonus share Π_v inside
 *  the payment hold (ADR-014): hold amount = 4 320 000 + 560 000. */
export const FINAL_PRICING: LegPricing = {
  grossMsat: 4_320_000n,
  depHubFeeMsat: 432_000n,
  arrHubFeeMsat: 432_000n,
  netMsat: 3_456_000n,
  finalizationBonusMsat: CARRIER_BONUS_MSAT,
};

export const DEADLINES = {
  funding: at(60),
  pickup: at(120),
  transit: at(600),
  storage: at(7 * 24 * 60),
} as const;

export function baseCtx(): ShipmentContext {
  return {
    shipmentId: IDS.shipment,
    senderId: IDS.sender,
    senderWalletConnected: true,
    originHubId: IDS.originHub,
    originHubUserId: IDS.originHubUser,
    destHubId: IDS.destHub,
    custodyBondMsat: BOND_MSAT,
    offerMsat: OFFER_MSAT,
    workCommitmentMsat: WORK_MSAT,
    originHubFeeBp: 1000, // 10%
    currentHubStay: null,
    leg: null,
    finalizationBonusHold: null,
  };
}

export function originStay(): ActiveHubStay {
  return {
    hubStayId: IDS.originStay,
    hubId: IDS.originHub,
    hubUserId: IDS.originHubUser,
    bondPaymentId: IDS.originHubBond,
    storageDeadlineAt: DEADLINES.storage,
  };
}

export function pendingLeg(): ActiveLeg {
  return {
    legId: IDS.leg,
    carrierId: IDS.carrier,
    fromHubId: IDS.originHub,
    fromHubUserId: IDS.originHubUser,
    toHubId: IDS.intermediateHub,
    toHubUserId: IDS.intermediateHubUser,
    arrivalHubStayId: IDS.arrivalStay,
    pricing: PRICING,
    legPaymentId: IDS.legPayment,
    carrierBondId: IDS.carrierBond,
    arrivalHubBondId: IDS.arrivalHubBond,
    fundingDeadlineAt: DEADLINES.funding,
    pickupDeadlineAt: null,
    transitDeadlineAt: null,
  };
}

export function bookedLeg(): ActiveLeg {
  return { ...pendingLeg(), pickupDeadlineAt: DEADLINES.pickup };
}

export function pickedUpLeg(): ActiveLeg {
  return { ...bookedLeg(), transitDeadlineAt: DEADLINES.transit };
}

/** The pending Π_h hold that accompanies a final leg (ADR-014). */
export function bonusHold(): FinalizationBonusHold {
  return { paymentId: IDS.finalizationBonus, amountMsat: HUB_BONUS_MSAT };
}

/** Destination-bound variants of the leg builders (rows 9 and 11): final
 *  pricing with the carrier bonus inside the payment hold. Pair them with
 *  `finalizationBonusHold: bonusHold()` in the context. */
export function pendingFinalLeg(): ActiveLeg {
  return { ...pendingLeg(), toHubId: IDS.destHub, toHubUserId: IDS.destHubUser, pricing: FINAL_PRICING };
}

export function finalLeg(): ActiveLeg {
  return { ...pickedUpLeg(), toHubId: IDS.destHub, toHubUserId: IDS.destHubUser, pricing: FINAL_PRICING };
}

export function destStay(): ActiveHubStay {
  return {
    hubStayId: IDS.arrivalStay,
    hubId: IDS.destHub,
    hubUserId: IDS.destHubUser,
    bondPaymentId: IDS.arrivalHubBond,
    storageDeadlineAt: DEADLINES.storage,
  };
}

/**
 * A representative (state, ctx) pair for every reachable state, used to probe
 * the full state × event matrix. AT_HUB comes in two flavours because several
 * guards branch on whether a leg is pending. AWAITING_PICKUP carries the
 * pending Π_h hold: that is how a shipment normally reaches it (ADR-014).
 */
export function ctxForState(state: ShipmentState | null): ShipmentContext {
  const ctx = baseCtx();
  switch (state) {
    case null:
    case 'DRAFT':
      return ctx;
    case 'AWAITING_DROPOFF':
      return { ...ctx, currentHubStay: originStay() };
    case 'AT_HUB':
      return { ...ctx, currentHubStay: originStay() };
    case 'LEG_BOOKED':
      return { ...ctx, currentHubStay: originStay(), leg: bookedLeg() };
    case 'IN_TRANSIT':
      return { ...ctx, leg: pickedUpLeg() };
    case 'AWAITING_PICKUP':
      return { ...ctx, currentHubStay: destStay(), finalizationBonusHold: bonusHold() };
    case 'DELIVERED':
    case 'CANCELLED':
    case 'FORFEITED':
    case 'LOST':
      return { ...ctx, currentHubStay: destStay() };
  }
}

/** A guard-satisfying payload for every event type (paired with ctxForState
 *  of a state where the event is legal). */
export function validEvent(type: ShipmentEvent['type']): ShipmentEvent {
  switch (type) {
    case 'create':
      return { type };
    case 'origin_hub_accept':
      return { type, hubStayId: IDS.originStay, hubWalletConnected: true };
    case 'origin_checkin':
      return { type, photoSha256: ['photo-a'], storageDeadlineAt: DEADLINES.storage };
    case 'leg_accept':
      return {
        type,
        legId: IDS.leg,
        carrierId: IDS.carrier,
        carrierWalletConnected: true,
        carrierTripActive: true,
        toHubId: IDS.intermediateHub,
        toHubUserId: IDS.intermediateHubUser,
        arrivalHubStayId: IDS.arrivalStay,
        arrivalHubAutoAccepts: true,
        arrivalHubWalletConnected: true,
        pricing: PRICING,
        finalizationHubBonusMsat: 0n,
        fundingDeadlineAt: DEADLINES.funding,
      };
    case 'leg_funded':
      return { type, now: at(30), pickupDeadlineAt: DEADLINES.pickup };
    case 'leg_funding_expired':
      return { type, now: at(61) };
    case 'pickup_checkout':
      return {
        type,
        now: at(90),
        hubConfirmed: true,
        carrierConfirmed: true,
        photoSha256: ['photo-checkout'],
        transitDeadlineAt: DEADLINES.transit,
      };
    case 'pickup_timeout':
      return { type, now: at(121) };
    case 'leg_checkin':
      return {
        type,
        now: at(300),
        hubId: IDS.intermediateHub,
        integrityConfirmed: true,
        photoSha256: ['photo-checkin'],
        storageDeadlineAt: DEADLINES.storage,
      };
    case 'leg_return':
      return {
        type,
        now: at(300),
        hubId: IDS.originHub,
        returnHubStayId: IDS.returnStay,
        photoSha256: ['photo-return'],
        storageDeadlineAt: DEADLINES.storage,
      };
    case 'recipient_pickup':
      return { type, otpVerified: true };
    case 'handoff_reject':
      return {
        type,
        stage: 'hub_checkin',
        rejectedById: IDS.intermediateHubUser,
        reason: 'packaging torn open',
        photoSha256: ['photo-evidence'],
      };
    case 'storage_expiry':
      return { type, now: at(7 * 24 * 60 + 1) };
    case 'transit_timeout':
      return { type, now: at(601) };
    case 'boost':
      return { type, amountMsat: 1_000_000n, atRemainingKm: 60 };
    case 'reroute':
      return {
        type,
        newDestHubId: IDS.intermediateHub,
        newDestHubUserId: IDS.intermediateHubUser,
        newRecipientEmail: null,
        newRemainingKm: 60,
      };
    case 'cancel':
      return { type };
  }
}
