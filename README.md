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

```sh
corepack enable          # provides pnpm (bundled with Node >= 22)
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d
pnpm dev
```

## Ground rules

- No money logic without tests; every movement goes through the double-entry
  (shadow) ledger.
- The platform never custodies funds — see
  [ADR-013](docs/adr/ADR-013-non-custodial-coordinator.md).
- Code and comments in English; UI in Italian (i18n-ready).
- Conventional commits, small and focused. Never commit secrets.

## License

[MIT](LICENSE)
