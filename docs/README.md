# Mercurio — Documentazione di progetto

> Regola dal CLAUDE.md: leggere `/docs` prima di ogni task; se manca una decisione,
> proporla e aggiornare `/docs`.

Stato attuale (2026-07-13): architettura approvata; implementati db+ledger,
auth/API di base, motore economico, matching, macchina a stati, coordinatore
escrow non custodiale e premio di finalizzazione (ADR-014). **Da
implementare**: mappa del vettore (ADR-015), API spedizioni/tratte, web UI.

## Documenti

| Documento                          | Contenuto                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, componenti, modello dati (ER), macchina a stati del pacco con eventi bond/escrow, invarianti                              |
| [ECONOMICS.md](ECONOMICS.md)       | Motore economico multi-tratta: 3 modelli simulati, raccomandazione (progress-based)                                              |
| [ESCROW.md](ESCROW.md)             | Pagamenti senza custodia: hold invoice dirette P2P, coordinatore per preimage, interfacce `WalletConnection`/`EscrowCoordinator` |
| [MATCHING.md](MATCHING.md)         | Matching vettore ↔ spedizioni: deviazione, scelta dell'hub, tariffa suggerita, ordinamento bacheca                               |
| [RISKS.md](RISKS.md)               | Integrità senza arbitro, anti-abuso, identità, svincolo a fine giacenza, GDPR, punti legali ⚖️                                   |

## Architecture Decision Records

| ADR                                                 | Decisione                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [ADR-001](adr/ADR-001-monorepo-typescript-pnpm.md)  | Monorepo TypeScript + pnpm workspaces                                                 |
| [ADR-002](adr/ADR-002-nextjs-web-fastify-api.md)    | Next.js per il web, API pubblica separata su Fastify + OpenAPI                        |
| [ADR-003](adr/ADR-003-postgresql-drizzle.md)        | PostgreSQL + Drizzle ORM                                                              |
| [ADR-004](adr/ADR-004-lnd-regtest-docker.md)        | bitcoind regtest + LND (wallet utente di test) via Docker Compose                     |
| [ADR-005](adr/ADR-005-escrow-backend-lnbits.md)     | ~~LNbits custodial~~ — superseded da ADR-013                                          |
| [ADR-006](adr/ADR-006-progress-based-economics.md)  | Ripartizione proporzionale ai km di avvicinamento                                     |
| [ADR-007](adr/ADR-007-haversine-distance.md)        | Distanze: haversine × 1.3 dietro `DistanceProvider`                                   |
| [ADR-008](adr/ADR-008-amounts-in-sats.md)           | Importi in msat; EUR solo input/display con cambio congelato                          |
| [ADR-009](adr/ADR-009-auth-email-lnurl.md)          | Auth: magic link email + LNURL-auth opzionale                                         |
| [ADR-010](adr/ADR-010-double-entry-ledger.md)       | Ledger a partita doppia, append-only, riconciliato                                    |
| [ADR-011](adr/ADR-011-pg-boss-jobs.md)              | Timeout e code su pg-boss (Postgres)                                                  |
| [ADR-012](adr/ADR-012-no-arbiter.md)                | Nessun arbitro: certificazioni + esiti deterministici, rifiuto al posto della disputa |
| [ADR-013](adr/ADR-013-non-custodial-coordinator.md) | Zero custodia: coordinatore per preimage, pagamenti diretti P2P                       |
| [ADR-014](adr/ADR-014-finalization-bonus.md)        | Premio di finalizzazione: 10% dell'impegno → 70% vettore finale, 30% hub finale       |
| [ADR-015](adr/ADR-015-carrier-route-map.md)         | Mappa del viaggio del vettore (Leaflet/OSM) + export percorso su Google Maps          |

## Stato delle decisioni

Le decisioni chiave sono state confermate in revisione il 2026-07-12 (elenco in
[RISKS.md §8](RISKS.md)): modello economico B con fee hub sul lordo di tratta, bond
unico fino a 1.000 €, valore dichiarabile ≤ 45 €, offerta libera con prezzo
consigliato, boost + reroute del mittente, ritiro definitivo senza finestra di
contestazione, nessun arbitro (ADR-012), nessun controllo AML preventivo,
**zero custodia in ogni momento** (ADR-013 — pagamenti diretti P2P, la piattaforma
non tocca mai fondi), fee piattaforma 0%. Restano aperti solo i punti legali ⚖️
(bloccano il mainnet, non lo sviluppo).
