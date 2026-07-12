// @mercurio/db — Drizzle ORM schema, migrations and repositories (ADR-003).
//
// The ER model is specified in /docs/ARCHITECTURE.md §4. Money-critical
// constraints (journal entries summing to zero, append-only ledger) are
// enforced in the database itself via triggers, not just in code (ADR-010).

export {};
