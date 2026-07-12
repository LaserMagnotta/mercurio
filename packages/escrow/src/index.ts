// @mercurio/escrow — the non-custodial payment layer (ADR-013, ESCROW.md).
//
// Mercurio NEVER holds funds. Every payment is a hold invoice (or an instant
// invoice) directly between two users' own wallets; this package only:
//   - talks to user wallets through the WalletConnection interface
//     (adapters: NWC for production, LND REST for dev/regtest, fake for tests)
//   - generates and guards payment preimages (PreimageCoordinator): revealing
//     a preimage releases a payment to its pre-determined payee; cancelling
//     returns funds to the payer. The platform can never redirect money to
//     itself — that invariant is enforced structurally and tested.

export * from './types';
export * from './crypto';
export * from './coordinator';
export * from './adapters/fake';
export * from './adapters/lnd-rest';
