// @mercurio/core — pure domain logic. NO I/O allowed in this package:
// the state machine, economics, matching and ledger are pure functions
// (state, event) -> (new state, effects), so that 100% of the money logic
// is unit-testable (CLAUDE.md: "no money logic without tests").
export * from './economics/economics.js';
export * from './matching/distance.js';
export * from './matching/matching.js';
export * from './matching/rates.js';
export * from './matching/route.js';
export * from './state-machine/custody-chain.js';
export * from './state-machine/state-machine.js';
