// Typed failures of the lifecycle executor, mapped to HTTP codes in the
// routes. Kept separate from lib/errors.ts (auth) on purpose: these carry
// money semantics.

import type { TransitionError } from '@mercurio/shared';

/** The pure state machine said no: wrong state or failed guard. */
export class TransitionRejectedError extends Error {
  constructor(readonly detail: TransitionError) {
    super(`${detail.code}: ${detail.message}`);
    this.name = 'TransitionRejectedError';
  }
}

/** A concurrent transition won the race; nothing was committed here. */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export type PaymentExecutionErrorCode =
  /** A hold that must be held synchronously (bond re-binds) never was. */
  | 'hold_not_held'
  /** An on-the-spot fee could not be settled: certification stays locked. */
  | 'instant_payment_failed'
  /** An instant-payment idempotency key was reused with other parameters. */
  | 'instant_idem_conflict';

export class PaymentExecutionError extends Error {
  constructor(
    readonly code: PaymentExecutionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PaymentExecutionError';
  }
}
