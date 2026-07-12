// @mercurio/core — pure domain logic. NO I/O allowed in this package:
// the state machine, economics, matching and ledger are pure functions
// (state, event) -> (new state, effects), so that 100% of the money logic
// is unit-testable (CLAUDE.md: "no money logic without tests").
//
// Modules to come (see /docs):
//   state-machine/  — shipment lifecycle (ARCHITECTURE.md §5)
//   ledger/         — double-entry shadow ledger postings (ADR-010)

export * from './economics/economics';
export * from './matching/distance';
export * from './matching/matching';
export * from './matching/rates';
