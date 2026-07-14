// @mercurio/shared — types, Zod schemas and constants shared across the monorepo.
// Domain types live here so web, api and core never drift apart.

/** All monetary amounts are millisatoshi (Lightning's native unit, ADR-008). */
export type Msat = bigint;

// protocol.ts is a leaf on purpose (see its header): api.ts needs its
// constants as VALUES at module scope, and pulling them through this barrel
// would be a circular value import that evaluates as undefined.
export * from './protocol';
export * from './economics';
export * from './matching';
export * from './state-machine';
export * from './api';
