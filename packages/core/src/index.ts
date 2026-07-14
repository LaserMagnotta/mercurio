// @mercurio/core — pure domain logic. NO I/O allowed in this package:
// the state machine, economics, matching and ledger are pure functions
// (state, event) -> (new state, effects), so that 100% of the money logic
// is unit-testable (CLAUDE.md: "no money logic without tests").
export * from './economics/economics';
export * from './matching/distance';
export * from './matching/matching';
export * from './matching/rates';
export * from './matching/route';
export * from './state-machine/custody-chain';
export * from './state-machine/state-machine';
