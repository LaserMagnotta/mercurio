// Board-ranking fixtures. The centerpiece is the numeric example of
// MATCHING.md §2, reproduced exactly by injecting a Euclidean provider: the
// doc's geometry is a plane with coordinates in km, so the test treats
// lng as x and lat as y and measures straight lines. EUR amounts map to msat
// at the fixture rate 1 EUR = 1000 sats = 1_000_000 msat (as in the
// economics fixtures), so rate_min 0.20 €/km = 200_000 msat/km.

import { describe, expect, it } from 'vitest';
import type {
  CarrierTrip,
  DimensionsCm,
  GeoPoint,
  MatchingHub,
  ShipmentAtHub,
} from '@mercurio/shared';
import type { DistanceProvider } from './distance';
import { createHaversineDistanceProvider, haversineKm } from './distance';
import { rankBoard } from './matching';

/** Plane geometry in km: x = lng, y = lat. */
const pt = (x: number, y: number): GeoPoint => ({ lat: y, lng: x });

const euclidean: DistanceProvider = {
  distanceKm: (a, b) => Math.hypot(a.lng - b.lng, a.lat - b.lat),
};

const BIG: DimensionsCm = { lengthCm: 100, widthCm: 100, heightCm: 100 };
const SMALL: DimensionsCm = { lengthCm: 20, widthCm: 15, heightCm: 10 };

function hub(
  hubId: string,
  location: GeoPoint,
  feeBp: number,
  overrides: Partial<MatchingHub> = {},
): MatchingHub {
  return {
    hubId,
    location,
    active: true,
    feeBp,
    maxDimsCm: BIG,
    maxWeightG: 20_000,
    acceptsUndeclared: true,
    walletConnected: true,
    autoAcceptDeposits: true,
    ...overrides,
  };
}

function shipment(overrides: Partial<ShipmentAtHub> = {}): ShipmentAtHub {
  return {
    shipmentId: 'ship-1',
    currentHubId: 'S',
    destHubId: 'T',
    poolMsat: 3_750_000n, // work pool × 60/80 (work pool 5.00 €, D = 80, r_S = 60)
    carrierBonusMsat: 350_000n, // accrued Π_v: 0.35 €, paid to whoever delivers to T
    totalKm: 80,
    remainingKm: 60,
    dimsCm: SMALL,
    weightG: 500,
    undeclared: false,
    ...overrides,
  };
}

const trip: CarrierTrip = {
  origin: pt(0, 0),
  destination: pt(100, 0),
  maxDeviationKm: 15,
  minRateMsatPerKm: 200_000n, // 0.20 €/km
};

describe('MATCHING.md §2 — the numeric example on plane geometry', () => {
  const hubs = [
    hub('S', pt(30, 10), 1000), // current hub, f_S = 10%
    hub('T', pt(90, 10), 1000), // destination, f_T = 10%
    hub('H1', pt(60, 5), 1000),
    hub('H3', pt(50, 40), 500),
  ];

  it('proposes T as H* (max surplus), keeps H1 as alternative, excludes H3 (detour > dev_max)', () => {
    const board = rankBoard(trip, [shipment()], hubs, euclidean);
    expect(board).toHaveLength(1);
    const card = board[0]!;

    expect(card.isMatch).toBe(true);
    // Direct delivery: detour = √1000 + 60 + √200 − 100 = 5.765 km (meter-
    // quantized), gross = whole pool 3.75 €, net = 3.75 × 0.8 + the 0.35 €
    // finalization bonus (ADR-014, only for H = T) = 3.35 €,
    // surplus = 3.35 € − 0.20 €/km × 5.765 km = 2.197 €.
    expect(card.bestDropHub).toEqual({
      hubId: 'T',
      detourKm: 5.765,
      netMsat: 3_350_000n,
      finalizationBonusMsat: 350_000n,
      surplusMsat: 2_197_000n,
    });
    // H1: detour = √1000 + √925 + √1625 − 100 = 2.348 km; progress = 60 −
    // √925 = 29.586 km; gross = 3.75 € × 29586/60000 = 1.849 € (sat floor);
    // each 10% fee is 184_900 msat floored to the sat → 184_000, so net =
    // 1_849_000 − 2 × 184_000 = 1.481 € (no bonus: H1 is not the
    // destination), surplus = 1.481 − 0.4696 = 1.0114 €.
    expect(card.alternatives).toEqual([
      {
        hubId: 'H1',
        detourKm: 2.348,
        netMsat: 1_481_000n,
        finalizationBonusMsat: 0n,
        surplusMsat: 1_011_400n,
      },
    ]);
    // H3 (detour 31.7 km > 15) is excluded outright, S itself gives zero
    // progress: neither may appear anywhere on the card.
    const shown = [card.bestDropHub, ...card.alternatives].map((o) => o.hubId);
    expect(shown).not.toContain('H3');
    expect(shown).not.toContain('S');
  });

  it('the match criterion follows the carrier floor: rate_min high enough kills the match', () => {
    // Effective rates: net(H1)/detour(H1) ≈ 0.63 €/km, net(T)/detour(T) ≈
    // 0.58 €/km (bonus included). At rate_min = 0.70 €/km every surplus is
    // negative: the card moves to the "Altre" section and H* becomes H1, the
    // least-negative option ("quanto manca alla convenienza", MATCHING.md §3).
    const greedy: CarrierTrip = { ...trip, minRateMsatPerKm: 700_000n };
    const board = rankBoard(greedy, [shipment()], hubs, euclidean);
    expect(board).toHaveLength(1);
    expect(board[0]!.isMatch).toBe(false);
    expect(board[0]!.bestDropHub.hubId).toBe('H1');
    expect(board[0]!.bestDropHub.surplusMsat).toBe(1_481_000n - (700_000n * 2348n) / 1000n);
    expect(board[0]!.bestDropHub.surplusMsat).toBeLessThan(0n);
  });

  it('when no candidate respects dev_max, H* falls back to the best overall and isMatch is false', () => {
    // Only S, T and H3 exist and the trip tolerates almost no deviation:
    // T (5.765 km) and H3 (31.7 km) both exceed dev_max = 1 km.
    const strict: CarrierTrip = { ...trip, maxDeviationKm: 1 };
    const board = rankBoard(strict, [shipment()], hubs, euclidean);
    expect(board).toHaveLength(1);
    expect(board[0]!.isMatch).toBe(false);
    expect(board[0]!.bestDropHub.hubId).toBe('T'); // still the best proposal to show
  });

  it('a consumed carrier quota removes the bonus line from T (post-arrival reroute, ADR-014)', () => {
    const board = rankBoard(trip, [shipment({ carrierBonusMsat: 0n })], hubs, euclidean);
    expect(board[0]!.bestDropHub).toEqual({
      hubId: 'T',
      detourKm: 5.765,
      netMsat: 3_000_000n,
      finalizationBonusMsat: 0n,
      surplusMsat: 1_847_000n,
    });
  });
});

describe('candidate filters (MATCHING.md §2, conditions 1–3)', () => {
  // One-dimensional geometry: everything on the x axis, direct route 100 km.
  const S = hub('S', pt(10, 0), 1000);
  const T = hub('T', pt(90, 0), 1000);
  const axisTrip: CarrierTrip = {
    origin: pt(0, 0),
    destination: pt(100, 0),
    maxDeviationKm: 15,
    minRateMsatPerKm: 0n,
  };
  const axisShipment = shipment({ poolMsat: 4_000_000n, totalKm: 80, remainingKm: 80 });

  const bestIds = (hubs: MatchingHub[], s: ShipmentAtHub = axisShipment): string[] => {
    const board = rankBoard(axisTrip, [s], hubs, euclidean);
    return board.flatMap((c) => [c.bestDropHub, ...c.alternatives].map((o) => o.hubId));
  };

  it('excludes hubs below the progress threshold max(5 km, 5% × D)', () => {
    // D = 80 km → threshold = 5 km. H at x=12 gives 2 km of progress.
    const tooClose = hub('H-close', pt(12, 0), 1000);
    const farEnough = hub('H-far', pt(20, 0), 1000); // 10 km of progress
    const ids = bestIds([S, T, tooClose, farEnough]);
    expect(ids).not.toContain('H-close');
    expect(ids).toContain('H-far');
  });

  it('always admits direct delivery to T, even below the progress threshold', () => {
    // Parcel 3 km from its destination (after a reroute, say): only the
    // final hop is possible and it must remain deliverable (ECONOMICS §6).
    const nearlyThere = shipment({
      currentHubId: 'S2',
      poolMsat: 150_000n,
      totalKm: 80,
      remainingKm: 3,
    });
    const S2 = hub('S2', pt(87, 0), 1000);
    const board = rankBoard(axisTrip, [nearlyThere], [S2, T], euclidean);
    expect(board).toHaveLength(1);
    expect(board[0]!.bestDropHub.hubId).toBe('T');
  });

  it('excludes hubs that cannot take the parcel: inactive, no wallet, no auto-accept, size, weight, undeclared', () => {
    const mid = pt(50, 0);
    const rejected = [
      hub('H-inactive', mid, 1000, { active: false }),
      hub('H-no-wallet', mid, 1000, { walletConnected: false }),
      hub('H-manual', mid, 1000, { autoAcceptDeposits: false }),
      hub('H-small', mid, 1000, { maxDimsCm: { lengthCm: 5, widthCm: 5, heightCm: 5 } }),
      hub('H-light', mid, 1000, { maxWeightG: 100 }),
      hub('H-declared-only', mid, 1000, { acceptsUndeclared: false }),
    ];
    const ids = bestIds([S, T, ...rejected], shipment({ ...axisShipment, undeclared: true }));
    for (const r of rejected) expect(ids).not.toContain(r.hubId);
    expect(ids).toContain('T');
  });

  it('allows rotated parcels: a 60×10×10 box fits a 15×80×12 limit', () => {
    const rotating = hub('H-rot', pt(50, 0), 1000, {
      maxDimsCm: { lengthCm: 15, widthCm: 80, heightCm: 12 },
    });
    const longBox = shipment({
      ...axisShipment,
      dimsCm: { lengthCm: 60, widthCm: 10, heightCm: 10 },
    });
    expect(bestIds([S, T, rotating], longBox)).toContain('H-rot');
  });

  it('a hub with a fee above the validation cap disqualifies itself instead of throwing', () => {
    const usurer = hub('H-usurer', pt(50, 0), 5000); // 50% > MAX_HUB_FEE_BP
    const ids = bestIds([S, T, usurer]);
    expect(ids).not.toContain('H-usurer');
    expect(ids).toContain('T');
  });

  it('skips shipments whose current or destination hub is unknown, without touching the rest', () => {
    const orphan = shipment({ shipmentId: 'orphan', currentHubId: 'missing' });
    const board = rankBoard(axisTrip, [orphan, axisShipment], [S, T], euclidean);
    expect(board.map((c) => c.shipmentId)).toEqual(['ship-1']);
  });

  it('skips malformed rows with a negative carrier bonus, like any other bad amount', () => {
    const bad = shipment({ shipmentId: 'bad-bonus', carrierBonusMsat: -1n });
    const board = rankBoard(axisTrip, [bad, axisShipment], [S, T], euclidean);
    expect(board.map((c) => c.shipmentId)).toEqual(['ship-1']);
  });
});

describe('haversine provider (ADR-007)', () => {
  it('one degree of longitude at the equator ≈ 111.195 km, × 1.3 by default', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 0, lng: 1 };
    expect(haversineKm(a, b)).toBeCloseTo(111.195, 3);
    expect(createHaversineDistanceProvider().distanceKm(a, b)).toBeCloseTo(144.554, 3);
    expect(createHaversineDistanceProvider(1.5).distanceKm(a, b)).toBeCloseTo(166.793, 3);
  });

  it('is symmetric and zero on identical points', () => {
    const bologna = { lat: 44.4949, lng: 11.3426 };
    const firenze = { lat: 43.7696, lng: 11.2558 };
    expect(haversineKm(bologna, firenze)).toBeCloseTo(haversineKm(firenze, bologna), 12);
    expect(haversineKm(bologna, bologna)).toBe(0);
  });

  it('rejects invalid coordinates and circuity factors', () => {
    expect(() => haversineKm({ lat: 91, lng: 0 }, { lat: 0, lng: 0 })).toThrow(RangeError);
    expect(() => haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: Number.NaN })).toThrow(RangeError);
    expect(() => createHaversineDistanceProvider(0.9)).toThrow(RangeError);
  });
});
