# Mercurio

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)

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
pnpm run setup                                     # runs DB migrations, then seeds demo data
COORDINATOR_KEY=$(openssl rand -hex 32) FAKE_WALLETS=true pnpm dev   # web (:3000) + api (:3001)
```

`COORDINATOR_KEY` is required by the API (see below); `FAKE_WALLETS=true`
enables dev-only in-memory Lightning wallets so every flow — holds included —
works without the regtest nodes (they live in the API process: a restart
forgets balances and pending holds). The web UI's manual walkthrough against
the seed is in [`apps/web/README.md`](apps/web/README.md).

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

Money-logic and auth tests (`packages/db`, `packages/escrow`, `apps/api`) run
against an in-process Postgres (`pglite`) with every migration applied — no
Docker required for `pnpm test` (the escrow coordinator is unit-tested on an
in-memory fake Lightning network).

### Lightning integration tests (`pnpm test:integration`)

The escrow coordinator is also tested against **real hold invoices** on the
regtest environment (ADR-004): HTLCs actually held, preimages actually
revealed, channel balances actually moving between the three user nodes.

```sh
docker compose -f infra/docker/docker-compose.yml up -d
./infra/docker/bootstrap.sh    # mine, fund wallets, open channels alice<->bob<->carol
pnpm test:integration
```

The suite covers: hold paid → `held`; release → the payee really collects;
refund → the payer is made whole; expiry → `expired` with nothing committed.
It reads the nodes' admin macaroons from `infra/docker/volumes/` and needs
nothing else running.

### Escrow coordinator key

The coordinator stores payment preimages only encrypted (AES-256-GCM,
ADR-013). Runtime deployments must set `COORDINATOR_KEY` to 32 random bytes
in hex — generate one with `openssl rand -hex 32`. Tests generate their own
throwaway keys.

### Photo blob storage

Certified handoff photos are uploaded to the API and stored content-addressed
(key = sha256) on the local filesystem under `PHOTO_STORAGE_DIR` (default
`./data/photos`, gitignored). Download is session-authorized only — no public
URLs. Retention is enforced by a nightly purge worker (ADR-020).

### Auth (magic link)

- `POST /auth/request-link { email }` — queues a sign-in email (outbox
  pattern); always responds `202` regardless of whether the address has an
  account yet (first login = signup). In dev, check
  http://localhost:8025 (Mailpit) for the email.
- `POST /auth/verify { token, consent? }` — `consent: { tosVersion,
privacyVersion }` is required only the first time an email logs in
  (GDPR explicit consent); sets an httpOnly session cookie.
- `POST /auth/logout` — revokes the session.
- `GET /me` — current user + active roles (`carrier`, `hub`).
- `POST /me/roles/carrier` — activates the carrier role (idempotent).
- `POST /me/roles/hub { ... }` — activates the hub role (one per account).
- `GET /me/export` — all of the caller's own data as JSON (GDPR portability).
- `DELETE /me` — anonymizes the account (GDPR erasure); the ledger and
  custody chain are append-only and keep referencing the user by id only,
  never by email, so anonymizing this one row severs the personal data.

### Shipment lifecycle API

The full shipment lifecycle (ARCHITECTURE.md §5) is served by the API and
documented as **OpenAPI at `/docs`** (generated from the shared Zod schemas,
`packages/shared/src/api.ts`). In short: `POST /me/wallet` connects the
caller's own Lightning wallet (a prerequisite for every money-bearing role,
ADR-013); `POST /shipments` freezes the EUR rate and route distance and
returns the parcel's QR token; hubs accept/check-in, carriers declare a trip
(`POST /trips`) and consult the ranked board (`GET /trips/:id/board`), then
accept legs, hand off with double confirmation, and the recipient collects
with an emailed OTP. Money moves only through the state machine's effects:
hold invoices between the parties' own wallets plus on-the-spot instant fees
— every movement mirrored in the shadow ledger and covered by the end-to-end
suite in `apps/api/src/shipments/`.

## Ground rules

- No money logic without tests; every movement goes through the double-entry
  (shadow) ledger.
- The platform never custodies funds — see
  [ADR-013](docs/adr/ADR-013-non-custodial-coordinator.md).
- Code and comments in English; UI in Italian (i18n-ready).
- Conventional commits, small and focused. Never commit secrets.

## License

[MIT](LICENSE)
