# Mercurio

Peer-to-peer logistics network: senders, occasional carriers and neighbourhood
hubs (shops, bars) move low-value, non-urgent parcels hop by hop. Payments run
on the Lightning Network as **direct peer-to-peer conditional payments (hold
invoices)** — the platform never holds user funds, it only coordinates
preimages. No arbiters: every monetary outcome follows deterministic protocol
rules.

> Project documentation (currently in Italian, English translation planned
> before public launch) lives in [`/docs`](docs/README.md) — start there.
> Key decisions are recorded as ADRs in [`/docs/adr`](docs/adr/).

## Repository layout

```
apps/
  web/        Next.js front-end (Italian UI, mobile-first, i18n-ready)
  api/        Fastify public REST API (OpenAPI), wallet-event handlers, workers
packages/
  core/       Pure domain logic: state machine, economics, matching, ledger
  db/         Drizzle ORM schema, migrations, repositories (PostgreSQL)
  escrow/     Non-custodial payment coordinator + wallet adapters (NWC, LND)
  shared/     Shared types, Zod schemas, constants
infra/
  docker/     Regtest Lightning dev environment (bitcoind + LND user wallets)
docs/         Architecture, economics, matching, risks, ADRs
```

## Getting started (development)

Prerequisites: Node >= 22, Docker Desktop (or compatible) running.

```sh
corepack enable                                    # provides pnpm (bundled with Node >= 22)
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d
pnpm setup                                         # runs DB migrations, then seeds demo data
pnpm dev                                            # starts web (:3000) and api (:3001)
```

`pnpm setup` is idempotent — safe to re-run any time (e.g. after `docker compose down -v`).

Docker Compose brings up: `postgres` (app data + shadow ledger), `mailpit`
(dev SMTP, web UI at http://localhost:8025) and three LND nodes in regtest —
`lnd-alice`/`lnd-bob`/`lnd-carol`, standing in for a sender's, a carrier's and
a hub's own wallets (the platform has none, ADR-013). To fund the wallets and
open channels between them for end-to-end Lightning testing, run
`infra/docker/bootstrap.sh` once the containers are up.

### Useful commands

| Command                                                     | What it does                                          |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `pnpm dev`                                                  | Runs all apps in watch mode (Turborepo)               |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` / `pnpm test` | Across every package                                  |
| `pnpm db:generate`                                          | Generates a new Drizzle migration from schema changes |
| `pnpm db:migrate`                                           | Applies pending migrations                            |
| `pnpm db:seed`                                              | (Re-)seeds demo data: 3 users, 3 hubs, 1 shipment     |
| `pnpm format`                                               | Formats the whole repo with Prettier                  |

Money-logic tests (`packages/db`: ledger invariants, seed data) run against
an in-process Postgres (`pglite`) with every migration applied — no Docker
required for `pnpm test`.

## Ground rules

- No money logic without tests; every movement goes through the double-entry
  (shadow) ledger.
- The platform never custodies funds — see
  [ADR-013](docs/adr/ADR-013-non-custodial-coordinator.md).
- Code and comments in English; UI in Italian (i18n-ready).
- Conventional commits, small and focused. Never commit secrets.

## License

[MIT](LICENSE)
