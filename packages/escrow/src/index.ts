// @mercurio/escrow — the non-custodial payment layer (ADR-013, ESCROW.md).
//
// Mercurio NEVER holds funds. Every payment is a hold invoice (or an instant
// invoice) directly between two users' own wallets; this package only:
//   - talks to user wallets through the WalletConnection interface
//     (adapters: NWC for production, LND REST for dev/regtest, fake for tests)
//   - generates and guards payment preimages (EscrowCoordinator): revealing a
//     preimage releases a payment to its pre-determined payee; cancelling
//     returns funds to the payer. The platform can never redirect money to
//     itself — that invariant is enforced structurally and tested.

export type Hex = string;

export type InvoiceState = 'open' | 'held' | 'settled' | 'cancelled' | 'expired';

/** A user's own wallet, connected via NWC or a direct node adapter.
 *  See ESCROW.md §5 for the full contract. */
export interface WalletConnection {
  makeHoldInvoice(
    amountMsat: bigint,
    hash: Hex,
    expirySeconds: number,
    memo: string,
  ): Promise<{ bolt11: string }>;
  makeInvoice(amountMsat: bigint, memo: string): Promise<{ bolt11: string }>;
  payInvoice(bolt11: string, maxFeeMsat: bigint): Promise<{ paymentHash: Hex }>;
  settleHoldInvoice(preimage: Hex): Promise<void>;
  cancelHoldInvoice(hash: Hex): Promise<void>;
  lookupInvoice(hash: Hex): Promise<InvoiceState>;
}
