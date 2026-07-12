# ADR-001 — Monorepo TypeScript con pnpm workspaces

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Mercurio ha web, API pubblica, logica di dominio ricca (macchina a stati, ledger,
economics, matching) e in futuro un'app mobile. La logica di denaro deve essere
condivisa e testata una volta sola, mai duplicata tra frontend e backend.

## Decisione

Un monorepo TypeScript gestito con **pnpm workspaces** + **Turborepo** per
orchestrare build/test/lint con cache. Pacchetti: `apps/web`, `apps/api`,
`packages/core`, `packages/db`, `packages/escrow`, `packages/shared`
(ARCHITECTURE §2). TypeScript `strict` ovunque; `packages/core` senza I/O.

## Alternative considerate

- **Repo separati (web / api)**: duplicazione dei tipi di dominio e degli schemi di
  validazione; attrito per un progetto a contributori sparsi. Scartato.
- **npm/yarn workspaces**: funzionano, ma pnpm ha link rigorosi (niente dipendenze
  fantasma) e disco/tempi migliori. Scartati senza rimpianti.
- **Nx invece di Turborepo**: più potente, più invasivo; Turborepo basta per 6 pacchetti.
- **Linguaggio diverso per il backend (Go/Rust)**: ottimi runtime, ma spaccherebbero
  in due la condivisione di tipi e validazione col web; il team è uno e TypeScript
  copre tutto lo stack. La logica critica è protetta da test, non dal linguaggio.

## Conseguenze

- Un solo `pnpm test` copre tutta la logica di denaro in CI.
- Tipi e schemi Zod condivisi tra API e web (e domani mobile via API client generato).
- Va mantenuta la disciplina dei confini tra pacchetti (lint rule su import).
