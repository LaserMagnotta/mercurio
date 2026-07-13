// Contracts of the non-custodial payment layer (ESCROW.md §5, ADR-013).
// The domain only ever talks to these two interfaces; concrete adapters
// (fake for tests, LND REST for dev/regtest, NWC for production) live in
// ./adapters.

import type { PaymentPurpose, PaymentRef } from '@mercurio/shared';

export type Hex = string;

/** Invoice states as observed at the ISSUING (payee) wallet. */
export type InvoiceState = 'open' | 'held' | 'settled' | 'cancelled' | 'expired';

/** A user's own wallet, connected via NWC or a direct node adapter.
 *  Mercurio never holds funds: it only asks the user's wallet to act. */
export interface WalletConnection {
  makeHoldInvoice(
    amountMsat: bigint,
    hash: Hex,
    expirySeconds: number,
    memo: string,
  ): Promise<{ bolt11: string }>;
  /** Instant (non-hold) invoice for hub fees and compensations (ESCROW.md §3).
   *  Returns the payment hash too: the caller polls lookupInvoice(hash) to
   *  verify settlement before unlocking the certification it gates. */
  makeInvoice(amountMsat: bigint, memo: string): Promise<{ bolt11: string; paymentHash: Hex }>;
  /** May stay pending forever (hold invoices): resolves once the payment is
   *  DISPATCHED (in flight), throws only on immediate failure (no route,
   *  insufficient balance, expired invoice). */
  payInvoice(bolt11: string, maxFeeMsat: bigint): Promise<{ paymentHash: Hex }>;
  settleHoldInvoice(preimage: Hex): Promise<void>;
  cancelHoldInvoice(hash: Hex): Promise<void>;
  lookupInvoice(hash: Hex): Promise<InvoiceState>;
}

/** Maps a Mercurio user to their wallet. The coordinator only ever asks for
 *  the payer and payee of a payment — asking for anyone else would be a bug
 *  (and is asserted in tests: zero-custody invariant 1). */
export type WalletResolver = (userId: string) => Promise<WalletConnection>;

export type ConditionalPaymentId = string;

export interface CreateConditionalPaymentParams {
  /** Needed to post shadow-ledger entries against the shipment's commitment
   *  account (ADR-010) without joining legs/hub_stays from here. */
  shipmentId: string;
  /** Pays the hold invoice. */
  payerId: string;
  /** Issues the hold invoice; gets the preimage on release. */
  payeeId: string;
  amountMsat: bigint;
  purpose: PaymentPurpose;
  ref: PaymentRef;
  /** Invoice expiry: past it an unpaid hold can no longer be paid. */
  holdWindowSeconds: number;
  /** Retried calls with the same key return the existing payment. */
  idem: string;
}

/** Wallet-observed transitions; core advances the shipment state machine on
 *  these (e.g. three payment_held → leg_funded). */
export type CoordinatorEventType =
  | 'payment_held'
  | 'payment_settled'
  | 'payment_cancelled'
  | 'payment_expired';

export interface CoordinatorEvent {
  type: CoordinatorEventType;
  paymentId: ConditionalPaymentId;
  shipmentId: string;
  purpose: PaymentPurpose;
  ref: PaymentRef;
  amountMsat: bigint;
  payerId: string;
  payeeId: string;
  at: string; // ISO 8601 UTC
}

/** The coordinator: generates and guards preimages, never touches money.
 *  Every observed transition is mirrored as a double-entry shadow-ledger
 *  journal entry (ADR-010). */
export interface EscrowCoordinator {
  createConditionalPayment(params: CreateConditionalPaymentParams): Promise<ConditionalPaymentId>;

  /** Reveal the preimage to the payee: they settle and receive directly from
   *  the payer. Idempotent on the payment's state. */
  release(id: ConditionalPaymentId, idem: string): Promise<void>;

  /** Cancel the hold: funds return to the payer, untouched. Idempotent. */
  refund(id: ConditionalPaymentId, idem: string): Promise<void>;

  /** One observation sweep over unresolved payments; applies transitions and
   *  returns the events they produced. Workers call this on a schedule. */
  pollOnce(): Promise<CoordinatorEvent[]>;

  /** Continuous observation loop built on pollOnce (plus transitions caused
   *  by release/refund calls in this process). */
  events(opts?: { pollIntervalMs?: number; signal?: AbortSignal }): AsyncIterable<CoordinatorEvent>;
}

export type EscrowErrorCode =
  | 'payment_not_found'
  | 'invalid_state'
  | 'preimage_unavailable'
  | 'idem_conflict';

export class EscrowError extends Error {
  constructor(
    readonly code: EscrowErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EscrowError';
  }
}
