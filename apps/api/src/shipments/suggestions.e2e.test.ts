// Suggestion endpoints and board card money display fields, end to end.
//
// The web UI is sats-first (ADR-008: EUR only at input/display, never
// recomputed client-side), so the API must hand it BOTH sides of every
// suggested figure — EUR for the copy, msat for the input prefill — plus the
// exchange snapshot each one was computed with. The board card additionally
// carries the shipment's FROZEN snapshot: the indicative € next to the net
// must use the rate that will govern the carrier's actual payout.

import { describe, expect, it } from 'vitest';
import { createLifecycleWorld, createShipmentAtHub, declareTrip, SATS_PER_EUR } from './test-world.js';
import { eurFloatToMsat } from '../lib/eur-rate.js';

describe('suggestion endpoints (sats-first web UI contract)', () => {
  it('suggested-offer returns EUR, its exact msat equivalent and the snapshot', async () => {
    const world = await createLifecycleWorld();
    const res = await world.api({
      method: 'GET',
      url: `/shipments/suggested-offer?originHubId=${world.hubA}&destHubId=${world.hubB}`,
      cookie: world.marco.cookie,
      expect: 200,
    });
    const body = res.json() as {
      routeKm: number;
      suggestedEur: number;
      suggestedMsat: string;
      eurRate: { satsPerEur: string; source: string; at: string };
    };
    expect(body.routeKm).toBe(100); // flat test geography, A→B
    // Cold start (no delivered shipments): 100 km × 0.05 €/km = 5 €.
    expect(body.suggestedEur).toBe(5);
    // The msat side is the server's own conversion, floored to a whole sat.
    expect(body.suggestedMsat).toBe(eurFloatToMsat(5, SATS_PER_EUR).toString());
    expect(BigInt(body.suggestedMsat) % 1000n).toBe(0n);
    expect(body.eurRate.satsPerEur).toBe(SATS_PER_EUR);
  });

  it('suggested-rate returns €/km, its msat/km equivalent and the snapshot', async () => {
    const world = await createLifecycleWorld();
    const res = await world.api({
      method: 'GET',
      url: '/trips/suggested-rate',
      cookie: world.luca.cookie,
      expect: 200,
    });
    const body = res.json() as {
      eurPerKm: number;
      msatPerKm: string;
      eurRate: { satsPerEur: string };
    };
    // Cold start: DEFAULT_CARRIER_RATE_EUR_PER_KM = 0.20 €/km.
    expect(body.eurPerKm).toBe(0.2);
    expect(body.msatPerKm).toBe(eurFloatToMsat(0.2, SATS_PER_EUR).toString());
    expect(body.eurRate.satsPerEur).toBe(SATS_PER_EUR);
  });

  it('board cards carry the shipment frozen snapshot', async () => {
    const world = await createLifecycleWorld();
    const { id } = await createShipmentAtHub(world);
    const tripId = await declareTrip(world, world.luca, -5, 50);

    const res = await world.api({
      method: 'GET',
      url: `/trips/${tripId}/board`,
      cookie: world.luca.cookie,
      expect: 200,
    });
    const { cards } = res.json() as {
      cards: {
        shipmentId: string;
        eurRate: { satsPerEur: string; source: string; at: string };
      }[];
    };
    const card = cards.find((c) => c.shipmentId === id);
    expect(card).toBeDefined();
    // Frozen at creation (test snapshot): the same rate the payout will use.
    // Numeric comparison — numeric(18,8) reads back with trailing zeros.
    expect(Number(card!.eurRate.satsPerEur)).toBe(Number(SATS_PER_EUR));
    expect(card!.eurRate.source).toBe('test-fixed');
    expect(new Date(card!.eurRate.at).getTime()).not.toBeNaN();
  }, 30_000);
});
