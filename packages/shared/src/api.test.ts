// Regression: api.ts builds its zod schemas at module scope from protocol
// constants. When those constants lived in the './index' barrel (which
// re-exports api.ts), the circular VALUE import evaluated as undefined and
// silently disabled the checks — z.number().max(undefined) never fires and
// z.enum(undefined) crashes at parse time. Importing through the barrel
// here reproduces exactly the consumer path that was broken.

import { describe, expect, it } from 'vitest';
import {
  createReviewBody,
  createShipmentBody,
  DEFAULT_LIST_LIMIT,
  listQuery,
  MAX_LIST_LIMIT,
  MAX_STORAGE_DAYS,
  meTripDto,
  shipmentStateSchema,
} from './index.js';

const validShipment = {
  originHubId: '00000000-0000-4000-8000-000000000001',
  destHubId: '00000000-0000-4000-8000-000000000002',
  recipientEmail: 'dest@example.com',
  dims: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  weightG: 200,
  undeclared: false,
  offerMsat: '8000000',
  custodyBondMsat: '24000000',
  maxStorageDays: MAX_STORAGE_DAYS,
};

describe('api schemas receive real constant values', () => {
  it('enforces the MAX_STORAGE_DAYS cap on shipment creation', () => {
    expect(createShipmentBody.safeParse(validShipment).success).toBe(true);
    expect(
      createShipmentBody.safeParse({ ...validShipment, maxStorageDays: MAX_STORAGE_DAYS + 1 })
        .success,
    ).toBe(false);
  });

  it('parses shipment states and review roles from the enums', () => {
    expect(shipmentStateSchema.parse('AT_HUB')).toBe('AT_HUB');
    const review = { subjectId: validShipment.originHubId, role: 'carrier', stars: 5 };
    expect(createReviewBody.safeParse(review).success).toBe(true);
    expect(createReviewBody.safeParse({ ...review, role: 'recipient' }).success).toBe(false);
    expect(createReviewBody.safeParse({ ...review, stars: 6 }).success).toBe(false);
  });

  it('applies DEFAULT_LIST_LIMIT/MAX_LIST_LIMIT and CARRIER_TRIP_STATUSES from the enums', () => {
    expect(listQuery.parse({}).limit).toBe(DEFAULT_LIST_LIMIT);
    expect(listQuery.safeParse({ limit: MAX_LIST_LIMIT + 1 }).success).toBe(false);
    expect(meTripDto.shape.status.parse('active')).toBe('active');
    expect(meTripDto.shape.status.safeParse('bogus').success).toBe(false);
  });
});
