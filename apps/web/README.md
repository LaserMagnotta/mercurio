# @mercurio/web

Next.js (App Router) front-end — Italian UI, English ready (next-intl,
cookie-based locale, no locale URLs), mobile-first per the
[Bitcoin Design Guide](https://bitcoin.design/guide/): sats are the primary
amount everywhere, EUR is an indicative secondary line rendered by the single
`Amount` component from the exchange snapshot the API provides (ADR-008,
ADR-018). The client never computes money: every figure comes from the API.

Delivered in part 1: foundations (i18n, typed API client reusing the shared
Zod schemas, design system), magic-link auth + wallet connection, the sender
flow (hub list, "Spedisci" form with suggested offer, printable QR, tracking
with boost/reroute/cancel) and the carrier flow (trip declaration with
suggested rate, ranked board, leg acceptance, route map with Google Maps
export — ADR-015). Part 2 (out of scope here): hub dashboard, double-confirm
handoffs, OTP pickup and recipient claim, review forms, profile page, GDPR
export/erasure UI.

## Architecture notes

- **Same-origin proxy (ADR-018)**: the browser talks to `/api/*`, rewritten
  by Next to the Fastify API (`API_URL`, default `http://localhost:3001`).
  No CORS anywhere; the httpOnly session cookie just works. Server-rendered
  pages (`/hubs`, `/p/[qrToken]`) call the API directly.
- **Shared schemas (ADR-002)**: form validation reuses `createShipmentBody`
  and `createTripBody` from `@mercurio/shared`; response types are `z.infer`
  of the shared DTOs. Client and server cannot drift.
- **Amounts (ADR-008)**: inputs are sats-first; suggestion endpoints return
  the server-computed msat side for prefills. The only client-side monetary
  arithmetic is the indicative € line (display-only, from the API snapshot).
- **Unit tests** (`pnpm --filter @mercurio/web test`): amount formatting,
  API client error normalization, and copy completeness — every shipment
  state, custody event type and mapped API error code must exist in BOTH
  locale catalogs.

## Running locally

```sh
docker compose -f infra/docker/docker-compose.yml up -d   # postgres, mailpit, lnd×3
pnpm install
pnpm run setup            # migrations + demo seed (marco/mario/giulia)

# API (separate terminal) — fake wallets make every flow exercisable
# without regtest nodes; the fake network lives in the API process, so a
# restart forgets balances and pending holds (dev-only limitation).
cd apps/api
$env:COORDINATOR_KEY = (openssl rand -hex 32)   # or any 64-hex string
$env:FAKE_WALLETS = 'true'
pnpm dev                  # http://localhost:3001 (OpenAPI at /docs)

# Web (separate terminal)
pnpm --filter @mercurio/web dev    # http://localhost:3000
```

Emails (magic links, tracking) land in Mailpit: http://localhost:8025.

## Manual verification against the seed

The demo seed creates three users with a hub each (Milano, Bologna, Firenze)
but no wallets and no sessions. The full happy path, all through real HTTP:

1. **Sender** — on http://localhost:3000: _Accedi_ with any email (e.g.
   `sara@example.com`), open the magic link from Mailpit, accept the GDPR
   consent (first login only). _Wallet_ → kind "Wallet fake" → any id (e.g.
   `sara`) → connect. _Spedisci_: origin "Bar Mario" (Bologna), destination
   "Tabaccheria Giulia" (Firenze), recipient email, 20×15×5 cm / 200 g,
   storage ≤ 48 h (Giulia's cap), offer via "Usa N sats" (suggested ~5,26 €
   over 105,2 km), bond e.g. 24000 sats (≈ 15 €).
   - The origin hub auto-accepts **only if its owner has a wallet**: sign in
     once as `mario@example.com` and connect a fake wallet first (same two
     steps above) if you want `AWAITING_DROPOFF` instead of `DRAFT`.
   - The detail page shows the printable QR (print button), amounts with the
     frozen rate, the custody chain and cancel/boost/reroute per state.
2. **Origin check-in** (hub UI is part 2 — one curl): as mario's session,
   `POST /shipments/:id/origin-checkin` with the shipment's `qrToken` and a
   64-hex `photoSha256` → the parcel is `AT_HUB` and enters the boards.
3. **Carrier** — sign in as a fourth email (e.g. `luca@example.com`),
   connect a fake wallet, _Viaggia_: from "Bar Mario" to "Tabaccheria
   Giulia", detour 15 km, rate via "Usa 320 sats/km" (suggested 0,20 €/km),
   declare. The board shows the parcel under **Per te** with the frozen
   net + separate delivery bonus, detour, bond and every rating.
   - _Anteprima sul percorso_ draws the leg on the OSM map before accepting.
   - _Accetta_ freezes the amounts and books the leg; the fake wallets fund
     the holds within ~1 min (pg-boss pump) → shipment `LEG_BOOKED`, holds
     shown as "vincolato" on the detail page, parcel off the board.
   - The route view lists the stops in optimal order and "Apri in Google
     Maps" uses the URL built by the API (nothing sent to Google before the
     click).
4. **Public QR page**: `/p/<qrToken>` shows status + hub names only.

## Known limitations (part 1)

- No `GET /me/shipments`/`GET /me/trips` in the API yet: the home page and
  the carrier page remember ids in `localStorage` (this device only).
- NWC wallets are on the roadmap (ADR-013): the API answers 501; the form
  explains it.
- The suggested-offer "forbice" is qualitative copy: the API does not expose
  historical percentiles yet.
