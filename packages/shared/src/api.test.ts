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
  MAX_STORAGE_HOURS,
  shipmentStateSchema,
} from './index';

const validShipment = {
  originHubId: '00000000-0000-4000-8000-000000000001',
  destHubId: '00000000-0000-4000-8000-000000000002',
  recipientEmail: 'dest@example.com',
  dims: { lengthCm: 20, widthCm: 15, heightCm: 5 },
  weightG: 200,
  undeclared: false,
  offerMsat: '8000000',
  custodyBondMsat: '24000000',
  maxStorageHours: MAX_STORAGE_HOURS,
};

describe('api schemas receive real constant values', () => {
  it('enforces the MAX_STORAGE_HOURS cap on shipment creation', () => {
    expect(createShipmentBody.safeParse(validShipment).success).toBe(true);
    expect(
      createShipmentBody.safeParse({ ...validShipment, maxStorageHours: MAX_STORAGE_HOURS + 1 })
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
});
