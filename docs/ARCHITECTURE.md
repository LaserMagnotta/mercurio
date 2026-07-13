# Mercurio — Architettura

> Stato: **bozza per revisione** — 2026-07-12.
> Le decisioni chiave sono motivate negli ADR in [`/docs/adr`](adr/).
> Nessuna riga di codice è stata scritta: questo documento è il progetto da approvare.

## 1. Obiettivo del documento

Definire stack, componenti, modello dati e macchina a stati del pacco per l'MVP di
Mercurio: rete logistica peer-to-peer con pagamenti Lightning, escrow e bond.
I temi verticali sono trattati nei documenti dedicati:

| Documento                    | Contenuto                                                             |
| ---------------------------- | --------------------------------------------------------------------- |
| [ECONOMICS.md](ECONOMICS.md) | Motore economico multi-tratta (modelli, simulazioni, raccomandazione) |
| [ESCROW.md](ESCROW.md)       | Scelta del backend escrow/bond su Lightning e interfaccia astratta    |
| [MATCHING.md](MATCHING.md)   | Motore di matching vettore ↔ spedizioni                               |
| [RISKS.md](RISKS.md)         | Rischi, anti-abuso, identità, aspetti legali, domande aperte          |

## 2. Stack tecnologico

Confermata la proposta di partenza, con alcune precisazioni. Motivazioni estese negli ADR.

| Livello        | Scelta                                                                                                                 | ADR                                                                         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Repo           | Monorepo TypeScript, pnpm workspaces + Turborepo                                                                       | [ADR-001](adr/ADR-001-monorepo-typescript-pnpm.md)                          |
| Web            | Next.js (App Router), mobile-first, i18n `it` default con `en` pronto                                                  | [ADR-002](adr/ADR-002-nextjs-web-fastify-api.md)                            |
| API            | Servizio Fastify separato, REST + OpenAPI generata da schema Zod                                                       | [ADR-002](adr/ADR-002-nextjs-web-fastify-api.md)                            |
| Database       | PostgreSQL 16 + Drizzle ORM (SQL esplicito, transazioni controllate)                                                   | [ADR-003](adr/ADR-003-postgresql-drizzle.md)                                |
| Lightning      | bitcoind regtest + LND (nodi _utente_ di test — la piattaforma non ha wallet) via Docker Compose                       | [ADR-004](adr/ADR-004-lnd-regtest-docker.md)                                |
| Pagamenti/bond | **Zero custodia**: hold invoice dirette tra utenti, coordinatore per preimage; wallet utente via NWC o adapter diretti | [ADR-013](adr/ADR-013-non-custodial-coordinator.md), [ESCROW.md](ESCROW.md) |
| Importi        | Tutto in **satoshi**; EUR solo per input/display con cambio fotografato                                                | [ADR-008](adr/ADR-008-amounts-in-sats.md)                                   |
| Contabilità    | Ledger a partita doppia in Postgres, nessun movimento fuori ledger                                                     | [ADR-010](adr/ADR-010-double-entry-ledger.md)                               |
| Job/timeout    | pg-boss (code su Postgres, niente Redis)                                                                               | [ADR-011](adr/ADR-011-pg-boss-jobs.md)                                      |
| Auth           | Magic link email (obbligatoria) + LNURL-auth opzionale                                                                 | [ADR-009](adr/ADR-009-auth-email-lnurl.md)                                  |
| Distanze       | Haversine × fattore di circuità 1.3, dietro interfaccia `DistanceProvider`                                             | [ADR-007](adr/ADR-007-haversine-distance.md)                                |
| Email          | Adapter SMTP; Mailpit in dev; outbox pattern (invii solo post-commit)                                                  | —                                                                           |

### Struttura del monorepo

```
mercurio/
├── apps/
│   ├── web/            # Next.js — UI italiana, mobile-first, Bitcoin Design Guide
│   └── api/            # Fastify — API pubblica REST, OpenAPI, wallet-event handler
├── packages/
│   ├── core/           # Dominio puro: macchina a stati, economics, matching, ledger.
│   │                   # Zero I/O: solo funzioni testabili. Qui vive tutta la logica di denaro.
│   ├── db/             # Schema Drizzle, migrazioni, repository
│   ├── escrow/         # EscrowCoordinator (vault preimage) + WalletConnection (NWC, LND dev, fake per i test)
│   └── shared/         # Tipi condivisi, schema Zod delle API, costanti
├── infra/
│   └── docker/         # docker-compose: postgres, bitcoind regtest, lnd×3, lnbits, mailpit
└── docs/
```

Regola strutturale: **`packages/core` non importa nulla che faccia I/O**. La macchina a
stati e il motore economico sono funzioni pure `(stato, evento) → (nuovo stato, effetti)`;
`apps/api` esegue gli effetti (scritture DB, chiamate escrow, email) in transazione.
Questo rende testabile al 100% la logica di denaro (requisito del CLAUDE.md).

## 3. Diagramma dei componenti

```mermaid
flowchart LR
    subgraph Utenti
        M[Mittente / Destinatario]
        V[Vettore]
        H[Hub]
    end

    M & V & H --> WEB[apps/web<br/>Next.js]
    WEB --> API[apps/api<br/>Fastify + OpenAPI]

    API --> CORE[packages/core<br/>state machine · economics<br/>matching · ledger ombra]
    API --> DB[(PostgreSQL<br/>dati + ledger + code pg-boss)]
    API --> ESC[packages/escrow<br/>EscrowCoordinator<br/>vault preimage — MAI fondi]

    ESC --> WA[WalletConnection<br/>NWC · adapter LND dev]
    WA --> WM[Wallet del mittente]
    WA --> WV[Wallet del vettore]
    WA --> WH[Wallet dell'hub]
    WM & WV & WH --- LN((Lightning Network<br/>bitcoind regtest in dev))

    WORK[Worker pg-boss<br/>timeout giacenza · scadenze ritiro<br/>email outbox · riconciliazione] --> DB
    WORK --> ESC
    API --> MAIL[SMTP / Mailpit]
    WORK --> MAIL
```

Note:

- **La piattaforma non ha un wallet**: ogni pagamento è una hold invoice o una
  invoice istantanea _tra due utenti_; il coordinatore detiene solo le preimage
  (ESCROW.md §2). I fondi non toccano mai Mercurio.
- I **worker** girano nello stesso processo di `apps/api` nell'MVP (pg-boss lo consente);
  separabili in seguito senza cambi di codice.
- Il **job di riconciliazione** confronta ogni notte le scritture del ledger ombra con
  lo stato reale delle invoice nei wallet degli utenti e apre un alert su divergenza.
- Le API sono pubbliche e documentate (OpenAPI servita su `/docs`): l'app mobile futura
  e integrazioni terze usano le stesse rotte del web.

## 4. Modello dati (ER)

Convenzioni: chiavi UUID v7, timestamp UTC `timestamptz`, importi `bigint` in **msat**
(arrotondati al sat nei payout), colonne monetarie mai `float`. Enum come tipi Postgres.

```mermaid
erDiagram
    USERS ||--o| HUBS : "gestisce (0..1)"
    USERS ||--o{ CARRIER_TRIPS : dichiara
    USERS ||--o{ SHIPMENTS : "crea (mittente)"
    USERS ||--o{ REVIEWS : "riceve / scrive"
    USERS ||--|| WALLET_CONNECTIONS : "wallet proprio (NWC)"
    USERS ||--|| ACCOUNTS : "conto ombra (esterno)"

    SHIPMENTS ||--o{ LEGS : "tratte (seq)"
    SHIPMENTS ||--o{ HUB_STAYS : "giacenze"
    SHIPMENTS ||--o{ CUSTODY_EVENTS : "catena di custodia"
    SHIPMENTS ||--o{ PHOTOS : ""
    SHIPMENTS ||--o{ REJECTIONS : "rifiuti"

    HUBS ||--o{ HUB_STAYS : ospita
    CARRIER_TRIPS ||--o{ LEGS : "esegue"
    LEGS ||--o{ CONDITIONAL_PAYMENTS : "pagamento tratta + bond vettore"
    HUB_STAYS ||--o| CONDITIONAL_PAYMENTS : "bond hub"

    ACCOUNTS ||--o{ POSTINGS : ""
    JOURNAL_ENTRIES ||--|{ POSTINGS : "min 2, somma 0"
    CONDITIONAL_PAYMENTS }o--|| USERS : "payer / payee"

    REJECTIONS ||--o{ PHOTOS : evidenze
    CUSTODY_EVENTS ||--o{ PHOTOS : ""
```

### Tabelle principali

**users** — `id, email (unique), lnurl_pubkey?, locale, created_at, gdpr_consent_at, deleted_at?`
(cancellazione = anonimizzazione: il ledger non si cancella, si scollega — vedi RISKS §GDPR).

**hubs** — `id, user_id, name, address, lat, lng, opening_hours (jsonb), max_dim_cm (l/w/h),
max_weight_g, accepts_undeclared (bool), fee_percent (numeric), max_storage_hours,
auto_accept (bool), active`. `fee_percent` è la percentuale configurabile dall'hub,
applicata al **lordo delle tratte adiacenti** (ECONOMICS.md §2); `auto_accept` abilita l'accettazione automatica dei depositi che
rispettano i vincoli dichiarati (necessaria perché l'hub di arrivo di una tratta
"accetta quando il pacco parte" senza interazione umana in tempo reale).

**carrier_trips** — `id, user_id, origin_lat/lng, dest_lat/lng, departs_at, expires_at,
max_deviation_km, min_rate_msat_per_km, status`. Il viaggio reale dichiarato prima di
consultare la bacheca (MATCHING.md).

**shipments** — `id, sender_id, origin_hub_id, dest_hub_id, recipient_email,
recipient_pickup_otp_hash, qr_token (random 128 bit), dims, weight_g,
declared_content?, undeclared (bool), offer_msat (impegno di spesa, pagato per
tratta — ADR-013), custody_bond_msat, max_storage_hours (≤ 7 giorni nell'MVP,
vincolo CLTV dei bond — ESCROW §4), eur_rate_snapshot (numeric + source + ts,
congelato alla creazione), status, distance_km (D: distanza origine→destinazione
calcolata alla creazione e congelata), created_at`.
`custody_bond_msat` è l'unico bond richiesto a chiunque prenda in custodia il pacco,
vettore o hub (vedi §6, "bond di custodia unico" — decisione da confermare in revisione).

**legs** — `id, shipment_id, seq, carrier_id, trip_id, from_hub_id, to_hub_id,
status (pending_funding|booked|picked_up|completed|returned|expired|failed),
accepted_at, funding_deadline_at, pickup_deadline_at, transit_deadline_at,
progress_km, gross_msat, dep_hub_fee_msat, arr_hub_fee_msat, net_msat,
finalization_bonus_msat, payment_cp_id, bond_cp_id` (riferimenti ai
`conditional_payments`: hold del pagamento tratta mittente→vettore e del bond
vettore→mittente). Gli importi sono calcolati e congelati all'accettazione
(ECONOMICS.md): le fee dei due hub adiacenti sono percentuali del lordo, pagate
dal vettore sul posto ai passaggi di mano; `finalization_bonus_msat` è la quota
vettore del premio ADR-014, > 0 solo sulla tratta che consegna a destinazione
(la hold di pagamento vale `gross + finalization_bonus`).

**hub_stays** — `id, shipment_id, hub_id, seq, status (reserved|active|released|expired),
reserved_at, checked_in_at, checked_out_at, storage_deadline_at, bond_cp_id`
(i guadagni dell'hub sono tracciati sulle tratte adiacenti: `arr_hub_fee_msat` della
tratta in ingresso, `dep_hub_fee_msat` di quella in uscita).

**custody_events** — `id, shipment_id, type (created|funded|hub_checkin|leg_accepted|
hub_checkout|hub_checkin_intermediate|leg_returned|arrived_destination|
recipient_pickup|handoff_rejected|rerouted|boosted|expired|cancelled),
actor_user_id, leg_id?, hub_stay_id?, payload jsonb, prev_event_hash, hash,
created_at`. Append-only, con hash concatenato: è la catena di custodia, la prova
documentale di chi ha certificato cosa.

**photos** — `id, shipment_id, custody_event_id?, rejection_id?, kind (content|sealed|
checkin|checkout|evidence), storage_key, sha256, taken_by, created_at, purge_after`
(retention limitata, GDPR — RISKS.md).

**wallet_connections** — `id, user_id, kind (nwc|lnd_rest|fake), connection_secret
(cifrato), capabilities (hold_invoice bool…), status, created_at`. Il wallet
dell'utente, mai i suoi fondi.

**conditional_payments** — `id, shipment_id, payer_id, payee_id, amount_msat,
purpose (leg_payment|custody_bond|finalization_bonus), ref_type+ref_id
(leg|hub_stay), payment_hash,
preimage_encrypted (AES-256-GCM, chiave COORDINATOR_KEY — ADR-013),
bolt11, state (created|held|settled|cancelled|expired), hold_window,
idempotency_key (unique: una retry di createConditionalPayment restituisce la
hold esistente), created_at, resolved_at`. La hold invoice tra due utenti con
preimage custodita dal coordinatore (ESCROW.md §2): l'unico "vincolo" che
esiste — la piattaforma non ha conti né saldi. `shipment_id` è denormalizzato:
il coordinatore scrive le journal entry ombra sul conto commitment della
spedizione senza join su legs/hub_stays.

**accounts / journal_entries / postings** — partita doppia _ombra_ (ADR-010): registra
gli impegni e i regolamenti osservati tra wallet esterni.

- `accounts`: `id, owner_type (user|shipment), owner_id, kind
(external_wallet|commitment), currency ('msat')`.
- `journal_entries`: `id, event_type, ref_type+ref_id, idempotency_key (unique), created_at`.
- `postings`: `id, journal_entry_id, account_id, amount_msat (signed)`.
  Vincolo: per ogni journal entry `SUM(amount_msat) = 0`, applicato da trigger.

**rejections** — `id, shipment_id, leg_id?, hub_stay_id?, rejected_by, stage
(hub_checkin|pickup_checkout|recipient_pickup), reason, created_at`. Il rifiuto di un
passaggio di mano: nessun ruling e nessun arbitro (ADR-012) — è documentazione (foto
collegate) e trigger di notifica al mittente, che può reagire con `reroute`/`boost`.

**reviews** — `id, shipment_id, author_id, subject_id, role (sender|carrier|hub),
stars (1..5), comment?, created_at`. Unique su `(shipment_id, author_id, subject_id, role)`;
si recensisce solo chi ha avuto un ruolo effettivo nella spedizione. Rating separato per
ruolo come da CLAUDE.md.

**rate_observations** — `id, leg_id, detour_km, net_msat, eur_rate, accepted_at`
(alimenta il suggeritore di tariffa, MATCHING.md §4).

**email_outbox** — `id, to, template, payload, status, attempts, created_at, sent_at`
(le email si accodano nella stessa transazione dell'evento e partono dal worker:
nessuna notifica per eventi mai avvenuti e nessun evento senza notifica).

## 5. Macchina a stati della spedizione

Stati e eventi in inglese (saranno gli enum nel codice), descrizioni in italiano.
Ogni transizione è un evento della catena di custodia e ogni effetto monetario è
una journal entry: **la macchina a stati è l'unica sorgente dei movimenti di denaro**.

```mermaid
stateDiagram-v2
    [*] --> DRAFT : create (wallet mittente connesso)
    DRAFT --> AWAITING_DROPOFF : origin_hub_accept<br/>⏳ bond hub origine (hold) · QR emesso
    DRAFT --> CANCELLED : cancel
    AWAITING_DROPOFF --> AT_HUB : origin_checkin (QR + foto)
    AWAITING_DROPOFF --> CANCELLED : cancel<br/>↩ bond hub annullato
    AT_HUB --> AT_HUB : boost / reroute (mittente, nessun movimento)
    AT_HUB --> LEG_BOOKED : leg_accept + leg_funded (finestra 60 min)<br/>⏳ pagamento tratta (mittente→vettore) · ⏳ bond vettore · ⏳ bond hub arrivo
    AT_HUB --> FORFEITED : storage_expiry<br/>pacco svincolato all'hub (ToS) · ↩ bond hub
    AT_HUB --> CANCELLED : cancel (solo hub origine, nessuna tratta attiva)<br/>💸 compensazione f_o×P diretta all'hub · ↩ bond hub
    LEG_BOOKED --> IN_TRANSIT : pickup_checkout (doppia conferma)<br/>💸 fee partenza (vettore→hub, sul posto) · ↩ bond hub cedente
    LEG_BOOKED --> AT_HUB : pickup_timeout<br/>🔑⚔ bond vettore → mittente · ↩ pagamento tratta
    IN_TRANSIT --> AT_HUB : leg_checkin hub intermedio (foto)<br/>💸 fee arrivo (vettore→hub) · 🔑 preimage al vettore: incassa la tratta · ↩ bond vettore
    IN_TRANSIT --> AT_HUB : leg_return (riconsegna all'hub di partenza)<br/>↩ pagamento tratta · ↩ bond vettore
    IN_TRANSIT --> AWAITING_PICKUP : leg_checkin hub destinazione<br/>💸 fee arrivo · 🔑 preimage al vettore · ↩ bond vettore
    IN_TRANSIT --> LOST : transit_timeout<br/>🔑⚔ bond vettore → mittente · ↩ pagamento tratta
    AWAITING_PICKUP --> DELIVERED : recipient_pickup<br/>(OTP = accettazione definitiva) · ↩ bond hub dest
    AWAITING_PICKUP --> AT_HUB : reroute (mittente)
    AWAITING_PICKUP --> FORFEITED : storage_expiry<br/>pacco svincolato · ↩ bond hub
    DELIVERED --> [*]
    CANCELLED --> [*]
    FORFEITED --> [*]
    LOST --> [*]
```

Legenda: ⏳ hold invoice pagata e pendente (fondi vincolati, mai presso la piattaforma) ·
🔑 rivelazione della preimage al beneficiario (incassa direttamente dal pagatore) ·
↩ annullamento della hold (i fondi tornano al pagatore) · 💸 pagamento istantaneo diretto ·
⚔ slash (il bond viene incassato dal beneficiario fissato ex-ante).

`AT_HUB → LEG_BOOKED → IN_TRANSIT → AT_HUB` è il ciclo multi-tratta: si ripete finché
l'hub di check-in non è quello di destinazione.

**Non esistono stati di disputa né arbitri** ([ADR-012](adr/ADR-012-no-arbiter.md)):
chi dovrebbe ricevere il pacco può solo **accettare** (certifica e la custodia passa)
o **rifiutare** (`handoff_reject`: foto + motivo, la custodia NON passa, lo stato non
cambia). Tutti gli esiti monetari derivano da regole deterministiche — certificazioni
e timeout — mai da un giudizio umano. Il ritiro del destinatario (OTP dopo ispezione)
è l'accettazione definitiva: chiude la spedizione, senza finestra di contestazione.

### Tabella eventi, guardie ed effetti monetari

| #   | Evento                           | Attore                                                       | Guardia                                                                                                                                                    | Effetti monetari (tutti P2P, journal entry ombra)                                                                                              |
| --- | -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `create`                         | Mittente                                                     | dati completi, hub validi, **wallet mittente connesso** (NWC)                                                                                              | — (snapshot cambio EUR congelato)                                                                                                              |
| 2   | `origin_hub_accept`              | Hub origine (auto se `auto_accept`)                          | dims/peso/undeclared ok, wallet hub connesso                                                                                                               | ⏳ bond hub: l'hub paga la hold invoice emessa dal mittente (hash del coordinatore)                                                            |
| 3   | `origin_checkin`                 | Hub origine                                                  | scan QR, foto obbligatoria                                                                                                                                 | — (parte il timer di giacenza)                                                                                                                 |
| 4   | `leg_accept`                     | Vettore                                                      | viaggio attivo, criteri match, wallet connesso; hub di arrivo accetta (auto)                                                                               | tratta in `pending_funding`; importi calcolati e congelati (ECONOMICS)                                                                         |
| 5   | `leg_funded`                     | Wallet-event                                                 | entro 60 min da `leg_accept`: ⏳ pagamento tratta (mittente paga hold del vettore) · ⏳ bond vettore (vettore paga hold del mittente) · ⏳ bond hub arrivo | le tre hold risultano _held_ → `LEG_BOOKED`; finestra scaduta → tutto annullato, si torna in bacheca                                           |
| 6   | `pickup_checkout`                | Hub cedente + vettore (doppia conferma QR)                   | entro `pickup_deadline`; certificazione sbloccata dal pagamento                                                                                            | 💸 fee di partenza (`f_dep` × lordo) vettore→hub, sul posto · ↩ bond hub cedente annullato                                                     |
| 7   | `pickup_timeout`                 | Worker                                                       | deadline superata                                                                                                                                          | 🔑⚔ preimage del bond vettore al mittente (incassa dal vettore) · ↩ pagamento tratta e bond hub arrivo annullati; spedizione torna in bacheca  |
| 8   | `leg_checkin` (hub intermedio)   | Hub ricevente                                                | scan QR, foto, **conferma integrità**; certificazione sbloccata dal pagamento della fee                                                                    | 💸 fee di arrivo (`f_arr` × lordo) vettore→hub · 🔑 preimage al vettore: incassa il lordo direttamente dal mittente · ↩ bond vettore annullato |
| 9   | `leg_checkin` (hub destinazione) | Hub destinazione                                             | idem                                                                                                                                                       | idem (il netto del vettore = lordo − le due fee pagate sul posto)                                                                              |
| 10  | `leg_return`                     | Vettore + hub di partenza della tratta                       | entro `transit_deadline`; l'hub cedente è tenuto a riaccettare il pacco che ha certificato al check-out (ToS)                                              | ↩ pagamento tratta e bond vettore annullati; la giacenza riparte                                                                               |
| 11  | `recipient_pickup`               | Destinatario + hub                                           | OTP + QR; l'ispezione precede l'OTP: digitarlo è l'**accettazione definitiva** (nessuna finestra di contestazione)                                         | ↩ bond hub destinazione annullato; spedizione chiusa                                                                                           |
| 12  | `handoff_reject`                 | Chi dovrebbe ricevere il pacco (hub, vettore o destinatario) | foto + motivo                                                                                                                                              | nessuno: la custodia non passa e lo stato non cambia; evento in catena di custodia, notifica al mittente (che può `reroute`/`boost`)           |
| 13  | `storage_expiry`                 | Worker                                                       | giacenza scaduta                                                                                                                                           | ↩ bond hub annullato; **pacco svincolato secondo ToS: il bene è la compensazione dell'hub** (nessun escrow prefinanziato — ADR-013)            |
| 14  | `transit_timeout`                | Worker                                                       | deadline transito superata                                                                                                                                 | 🔑⚔ preimage del bond vettore al mittente · ↩ pagamento tratta annullato (le fee già pagate sul posto restano pagate)                          |
| 15  | `boost`                          | Mittente                                                     | stato con pacco fermo                                                                                                                                      | nessun movimento: aumenta l'impegno di spesa per le tratte future (ECONOMICS §5)                                                               |
| 16  | `reroute`                        | Mittente                                                     | stato `AT_HUB` o `AWAITING_PICKUP`, nessuna tratta prenotata                                                                                               | nessun movimento; nuovo hub destinazione e/o destinatario, `r` ricalcolata, OTP invalidato e riemesso                                          |
| 17  | `cancel`                         | Mittente                                                     | solo prima del primo `pickup_checkout`                                                                                                                     | 💸 compensazione hub origine `f_o × P` pagata direttamente (la restituzione del pacco si sblocca al pagamento) · ↩ bond hub annullato          |

### Premio di finalizzazione (ADR-014 — implementato)

Integrazioni alla tabella qui sopra, decise e implementate il 2026-07-13
(razionale e precisazioni implementative in
[ADR-014](adr/ADR-014-finalization-bonus.md)):

- **Riga 4/5 (tratta finale, `to_hub = hub destinazione`)**: la hold del
  pagamento tratta vale `lordo + Π_v` (quota vettore del premio) e si aggiunge
  una **quarta hold** ⏳ premio hub (`purpose: finalization_bonus`,
  mittente→hub destinazione, ref sull'`hub_stay` di destinazione);
  `LEG_BOOKED` richiede tutte le hold create _held_ (quattro; tre se `Π_h`
  floora a 0 sat, nel qual caso la hold non nasce proprio).
- **Riga 9 (check-in a destinazione)**: il vettore incassa lordo + `Π_v`
  (stessa preimage, stessa hold); le fee restano calcolate sul solo lordo.
- **Riga 11 (`recipient_pickup`)**: 🔑 preimage del premio hub all'hub di
  destinazione — l'hub è premiato per la consegna completata, non per l'arrivo.
- **Righe 13 e 16 (`storage_expiry` in consegna, `reroute` da
  `AWAITING_PICKUP` con cambio di destinazione)**: ↩ la hold del premio hub
  viene annullata (nel reroute, la nuova tratta finale ne creerà una nuova
  verso il nuovo hub). Il cambio del **solo destinatario** mantiene la hold:
  l'hub corrente completa comunque la consegna. È l'unico caso in cui la
  riga 16 muove denaro.
- I fallimenti della tratta finale (righe 7, 10, 14 e la finestra di funding)
  annullano anche la hold del premio hub, come le altre.
- Schema: `legs.finalization_bonus_msat` (0 per le tratte non finali),
  valore `finalization_bonus` nell'enum `conditional_payment_purpose`
  (migrazione 0003); journal entry `finalization_bonus_held/released/refunded`,
  mentre le entry `leg_payment_*` portano l'importo pieno `lordo + Π_v`.

**Principio di responsabilità ("la responsabilità segue la custodia certificata")**: chi
riceve il pacco (hub o vettore) ne certifica l'integrità al check-in/check-out con foto.
Da quel momento il danno scoperto dopo è attribuito al custode corrente, il cui bond è
l'unica garanzia in gioco. Questo rende sicuri i **payout immediati per tratta**: le
tratte già certificate integre sono chiuse e non soggette a clawback.

### Invarianti (da testare sempre)

1. **Zero custodia**: la piattaforma non è mai pagatore, beneficiario o detentore di
   un pagamento; nel ledger non esiste alcun conto della piattaforma con saldo
   (test strutturale, non solo funzionale).
2. **Conservazione dell'impegno**: per ogni spedizione, `Σ lordi tratte pagate ≤ P + boost`
   e ogni hold è o annullata (fondi al pagatore) o regolata (fondi al beneficiario
   fissato ex-ante). Nessun msat con destinazione decisa a posteriori.
3. **Ledger ombra bilanciato**: ogni journal entry somma a zero (trigger DB + test).
4. **Un solo custode**: in ogni istante il pacco ha esattamente un custode con bond
   attivo (hub o vettore), dallo stato `AT_HUB` in poi.
5. **Idempotenza**: ogni evento porta una `idempotency_key`; wallet-event e retry non
   duplicano movimenti.
6. **Riconciliazione**: lo stato di ogni `conditional_payment` nel ledger coincide con
   lo stato reale dell'invoice nel wallet dell'emittente (job notturno + on-demand).
7. **Default sicuro**: se il coordinatore si ferma, ogni hold scade e i fondi tornano
   ai pagatori: nessuno stato di errore lascia denaro in limbo permanente.

### Precisazioni implementative (`packages/core/src/state-machine`)

La macchina è implementata come funzione pura
`transition(state, event, ctx) → { nextState, effects[] } | errore tipizzato`;
gli effetti sono dati dichiarativi (mai I/O) che l'API esegue in un'unica
transazione. Tipi condivisi in `@mercurio/shared` (`ShipmentEvent`,
`ShipmentEffect`, `ShipmentContext`); helper della catena di custodia
(`custodyEventHash`, `verifyCustodyChain`: sha256 di payload canonico +
`prev_event_hash`) in `@mercurio/core`. Decisioni emerse implementando, tutte
forzate dagli invarianti qui sopra (non scelte libere di protocollo):

1. **`leg_funding_expired` è un evento esplicito** (il ramo "finestra scaduta"
   della riga 5): annulla le tre hold, quindi deve passare dalla macchina. I
   suoi annullamenti non generano journal entry a livello di macchina: gli
   impegni entrano nel ledger ombra solo a `leg_funded` — una hold annullata
   prima della prenotazione non è mai diventata un impegno. Precisazione dal
   coordinatore (ADR-013): una hold che il wallet aveva già accettato viene
   comunque registrata come impegno **osservato** e il suo annullamento come
   rimborso — due scritture vere a somma zero; le chiavi di idempotenza
   deterministiche `cp:<paymentId>:<transizione>` garantiscono che macchina e
   coordinatore non possano mai contare due volte lo stesso fatto.
2. **`leg_return` rimborsa anche il bond dell'hub di arrivo** (la sua giacenza
   non si attiverà mai) e **l'hub cedente che riaccetta blocca un bond
   nuovo**: il suo precedente era stato liberato al check-out e chi prende la
   custodia impegna il bond (§6); senza, l'invariante 4 resterebbe scoperto.
3. **`transit_timeout` rimborsa anche il bond dell'hub di arrivo** (omesso
   nella riga 14, implicato dall'invariante 2: ogni hold o si regola o si
   annulla).
4. **Timer di giacenza**: armato a ogni check-in, disarmato a `leg_funded`
   (col vettore impegnato la giacenza è sospesa) e riarmato con la scadenza
   originale se `pickup_timeout` riporta il pacco in bacheca. Se la giacenza
   scade con una tratta ancora in `pending_funding`, le hold pendenti vengono
   annullate nella stessa transizione di `storage_expiry`. Gli eventi di
   timeout consumano il proprio timer (nessun `cancel_timeout` su sé stessi).
5. **`reroute` emette l'effetto dedicato `rotate_pickup_otp`** (l'API invalida
   e riemette l'OTP eseguendolo). Caso particolare: cambiare **solo il
   destinatario** con pacco già all'hub di destinazione mantiene
   `AWAITING_PICKUP` (tornare in `AT_HUB` incaglierebbe il pacco: da lì non
   esiste tratta a progresso positivo) e il nuovo destinatario riceve subito
   l'email con il nuovo OTP.
6. **`boost` è ammesso anche da `AWAITING_PICKUP`**: ECONOMICS §5 prevede che
   il reroute dallo stato di consegna a pool esaurito richieda un boost.
7. **Fee istantanee a importo zero** (hub configurato allo 0%): l'effetto di
   pagamento e la sua journal entry vengono omessi del tutto.
8. **Email**: solo quelle previste dai documenti (check-in intermedio →
   mittente e destinatario; arrivo a destinazione → destinatario; ritiro →
   mittente; `handoff_reject` → mittente). OTP, preavvisi di giacenza e
   solleciti sono responsabilità del worker, non della macchina.
9. **Niente PII nella catena di custodia**: i payload registrano che il
   destinatario è cambiato, mai l'email — la catena è immutabile e la
   cancellazione GDPR non deve romperla (RISKS §6).
10. **Autorizzazione fuori dalla macchina**: sessioni, possesso del QR e
    verifica dell'hash OTP sono dell'API; la macchina valida le guardie di
    protocollo su fatti dichiarati dal chiamante (`otpVerified`, hash foto,
    doppia conferma).
11. **Premio di finalizzazione nel contesto** (ADR-014): `ShipmentContext`
    porta `workCommitmentMsat` (impegno work del segmento corrente, per la
    compensazione di annullamento — a `create` la macchina esige che sia lo
    split esatto dell'offerta) e `finalizationBonusHold` (la hold `Π_h`
    pendente, dal `leg_accept` finale al regolamento). L'evento `leg_accept`
    dichiara `finalizationHubBonusMsat`; guardie: quote > 0 solo su tratte
    finali, mai un nuovo `leg_accept` con una hold premio non riassorbita.

## 6. Bond di custodia unico (proposta)

Il CLAUDE.md definisce il bond del vettore (scelto dal mittente, es. 15 €) ma non
dimensiona quello degli hub. Proposta: **un unico importo `custody_bond` per spedizione,
fissato dal mittente, richiesto a chiunque prenda la custodia** (hub o vettore). Il rischio
coperto è lo stesso (perdita/danno del pacco in custodia), l'UX è più semplice ("questa
spedizione richiede un bond di 15 €") e la dashboard hub mostra un solo numero.
Da confermare in revisione.

## 7. Sicurezza dei passaggi di mano

- Il **QR sul pacco** contiene solo il `qr_token` (identificatore opaco): chiunque lo
  inquadri vede al massimo lo stato pubblico. Nessuna azione è possibile col solo QR.
- Ogni azione (check-in, check-out, ritiro) richiede QR **+ sessione autenticata**
  dell'attore legittimo; il ritiro del destinatario richiede in più l'**OTP** ricevuto
  via email (il QR è esposto sul pacco, quindi da solo non può autorizzare nulla).
- Il check-out hub→vettore è a **doppia conferma**: entrambe le parti confermano
  dall'app entro la stessa finestra; il pacco cambia custode in modo atomico.
- Foto obbligatorie a ogni check-in/check-out lato hub; hash della foto nella catena
  di custodia.

## 8. Ambiente di sviluppo (Docker)

`infra/docker/docker-compose.yml` (dettagli in ADR-004):

| Servizio                                                       | Ruolo                                                                               |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `postgres`                                                     | dati applicativi + ledger ombra + pg-boss                                           |
| `bitcoind` (regtest)                                           | chain locale, mining on-demand                                                      |
| `lnd-alice` (mittente), `lnd-bob` (vettore), `lnd-carol` (hub) | i **wallet degli utenti** di test — la piattaforma non ha un nodo proprio (ADR-013) |
| `mailpit`                                                      | SMTP di sviluppo con UI web                                                         |

Script di bootstrap: mina blocchi, finanzia i wallet, apre canali alice↔bob↔carol.
In dev i wallet sono collegati con l'adapter `lnd_rest` (stessa interfaccia
`WalletConnection` dell'adapter NWC di produzione). I test di integrazione della
logica di denaro — hold pagate, preimage rivelate, annullamenti — girano contro
questo ambiente in CI.

## 9. Cosa NON è nell'MVP

App mobile (le API pubbliche sono il prerequisito, già coperto), routing stradale reale
(ADR-007), negoziazione per tratta (ECONOMICS §modello C), bond non custodiali via hold
invoice (ESCROW §roadmap), assicurazione. L'arbitrato delle dispute non è "non ancora
nell'MVP": **non esiste by design** (ADR-012) — gli esiti sono regole deterministiche.
