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
export — ADR-015).

Delivered in part 2: the hub flows (`/hub` role registration + deposit
dashboard, `/hub/shipments/:id` state-driven operations: origin accept and
check-in, double-confirmation checkout, arrival/return check-in, OTP pickup,
claimed pickup, documentary handoff-reject), the carrier side of the
checkout + reject on the shipment page, the recipient tracking/claim page
(`/track/:id`, linked from the lifecycle emails — ADR-016), reviews on
closed shipments + the public profile (`/users/:id`, ADR-017) and the GDPR
account page (`/account`: export + erasure). Photos are certified by
client-computed sha256 (WebCrypto) and, since ADR-020, uploaded: the file is
re-encoded on device (EXIF stripped, max 2048 px) BEFORE hashing, the bytes
are pushed after the transition, and participants see the thumbnails in the
custody timelines and the hub ops gallery. QR fields accept the scanned
`/p/<token>` URL or the bare token, and since ADR-021 they also offer an
in-page camera scanner where the browser ships the native BarcodeDetector.
Since ADR-022 the "Spedisci" form also takes the sender's optional creation
photos (content / sealed parcel): same on-device hash + post-creation upload
pipeline, certified by the genesis `created` custody event — counterparties
see them in the hub ops gallery and in the custody timelines.

Also closed the same day (ADR-018 §5): the home page and `/carrier` now read
a user's own shipments and declared trips from the account (`GET
/me/shipments`, `GET /me/trips`, paginated) instead of remembering ids in
`localStorage`.

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
but no wallets and no sessions. The full happy path, all through the UI
(each actor is a browser session: sign in via the Mailpit magic link, accept
the GDPR consent on first login, connect a fake wallet from _Wallet_):

1. **Sender** (e.g. `sara@example.com` + fake wallet `sara`) — _Spedisci_:
   origin "Bar Mario" (Bologna), destination "Tabaccheria Giulia" (Firenze),
   recipient email, 20×15×5 cm / 200 g, storage ≤ 48 h (Giulia's cap), offer
   via "Usa N sats", bond e.g. 24000 sats (≈ 15 €).
   - The origin hub auto-accepts **only if its owner has a wallet** (connect
     `mario@example.com` + fake wallet `mario` first); otherwise the request
     appears in Mario's dashboard for the **manual accept**.
   - The detail page shows the printable QR, amounts with the frozen rate,
     the custody chain and cancel/boost/reroute per state.
   - Back on the home page, the shipment now appears under **Le tue
     spedizioni** (`GET /me/shipments`, ADR-018 §5) with its route and
     status, newest first.
2. **Origin hub** (mario) — _Hub_ → "Il tuo hub": the dashboard lists deposit
   requests (manual accept) and the stays with storage deadlines. Open the
   stay's operations page and certify the **check-in**: paste the parcel QR
   (the full `/p/<token>` URL works) and pick a photo — hashed on-device,
   only the sha256 is sent → `AT_HUB`, parcel on the boards. The tracking
   email (personal claim token + `/track/:id` link) lands in Mailpit.
3. **Carrier** (`luca@example.com` + fake wallet) — _Viaggia_: declare the
   trip Bar Mario → Tabaccheria Giulia, rate via "Usa 320 sats/km"; the
   board shows the parcel under **Per te** with the frozen net + delivery
   bonus; _Accetta_ books the leg; the fake wallets fund the holds within
   ~1 min (pg-boss pump) → `LEG_BOOKED`.
   - Back on `/carrier`, the declared trip shows as the **Viaggio attivo**
     banner (`GET /me/trips`, ADR-018 §5) — the most recently declared trip,
     still `active` and unexpired.
4. **Checkout, double confirmation**: luca on the shipment page ("Azioni del
   vettore": QR + confirm) and mario on the operations page (QR + photo)
   within 15 minutes of each other → `IN_TRANSIT`.
5. **Destination hub** (giulia + fake wallet, connected BEFORE the leg was
   accepted — the arrival bond is hers): operations page → arrival check-in
   with photo + integrity confirmation → `AWAITING_PICKUP`; the recipient
   gets the OTP email. **Pickup**: QR + OTP on the operations page →
   `DELIVERED`. A `handoff-reject` (photos + reason) is offered at every
   receiving step instead of certifying (ADR-012).
6. **Reviews** (any participant, closed shipment): the detail page offers
   the form over the effective participants (ADR-017); the public profile
   `/users/:id` shows per-role aggregates and received reviews.
7. **Recipient claim** (second shipment, parcel `AT_HUB`): open the
   `/track/:id` link from the tracking email as a signed-in account with a
   wallet (e.g. `rita.dest@example.com` + fake wallet `rita`), paste the
   personal code → the frozen amounts (residual pool + Π_v) and the 60-min
   funding window appear; once funded → `CLAIMED` with counter instructions
   and the token QR. The custodian hub completes from its operations page
   (parcel QR + claim token) → `DELIVERED` (ADR-016).
8. **GDPR** (`/account`, linked from the header email): JSON export
   downloaded client-side; irreversible anonymizing erasure with
   confirmation (signs you out).
9. **Public QR page**: `/p/<qrToken>` shows status + hub names only.

## Known limitations (part 2)

- NWC wallets are implemented (ADR-019): the API validates the connection
  string and probes capabilities live (relay reachability, encryption
  negotiation, method list) before accepting it. Real-wallet interop is
  **verified, not deferred** (ADR-019 §7): the regtest environment runs a
  real nostr relay plus two Alby Hub wallet services on the ADR-004 LND
  nodes, and `pnpm test:integration` drives the full hold lifecycle through
  them (probe, funding → held, release, refund, expiry). Reproduce with
  `docker compose -f infra/docker/docker-compose.yml up -d`, then
  `./infra/docker/bootstrap.sh`, then `pnpm test:integration`.
- The suggested-offer "forbice" is qualitative copy: the API does not expose
  historical percentiles yet.
- Photo blobs are stored on the API host's filesystem (ADR-020,
  `PHOTO_STORAGE_DIR`); an S3-compatible driver is future work — the
  `BlobStore` interface is the boundary.
- The in-page QR scanner (ADR-021) decodes with the browser's native
  BarcodeDetector and ships **no decoding library** in the bundle. It works on
  Android Chrome/Edge (and ChromeOS/macOS Chrome) — the mobile-first target;
  on iOS Safari, Firefox and Chrome on Windows/Linux the API is absent, so
  those fall back to the universal text field (paste from the system camera app
  or a hardware scanner, or type the token). Adding a JS decoder later is a
  localized change behind the `QrScanInput` component. The camera stream never
  leaves the device and no frame is stored.
