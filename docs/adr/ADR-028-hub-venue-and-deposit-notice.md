# ADR-028 — Foto del locale, email di contatto e avviso di deposito all'hub

- Stato: accettato e implementato — 2026-07-18 (Fase 2 punto 6 del backlog UX)
- Contesto: CLAUDE.md «Hub — dettagli» (registrazione dell'hub, dashboard delle
  richieste di deposito); [ADR-020](ADR-020-photo-blob-storage.md) (blob storage
  content-addressed, strip EXIF sul dispositivo, purge worker) e
  [ADR-023](ADR-023-s3-blob-storage-driver.md) (driver da config); il pattern
  outbox (`email_outbox` + `apps/api/src/shipments/outbox.ts`, ARCHITECTURE §4);
  RISKS.md §6 (minimizzazione dati). Prepara la Fase 3 (scoperta hub): il locale
  con una foto è più scegliibile.

## Contesto

Il punto 6 chiede tre cose attorno all'hub come **luogo scelto** da mittenti e
vettori:

1. un **avviso** all'hub a ogni nuova richiesta di deposito (finora l'hub
   scopriva le richieste solo aprendo la dashboard — nessuna notifica);
2. un'**email di contatto del locale**, distinta dall'account, dove ricevere
   quell'avviso;
3. una **foto del locale**, pubblica, per far vedere il negozio/bar.

La domanda non ovvia è la (3): le foto di ADR-020 sono legate a una
`shipment_id`, private, effimere (purge a chiusura + 30 giorni) e certificate
nella catena di custodia. Una foto del **locale** non ha nulla di tutto ciò: è
dell'hub, pubblica e permanente. Va nella tabella `photos` con una `hub_id`
nullable, o in una casa propria?

## Decisioni

### 1. Foto del locale in una tabella e uno store SEPARATI — non in `photos`

`hub_photos (id, hub_id, kind, storage_key, sha256, created_at)`, con un blob
store dedicato (`app.venueBlobStore`). **Non** si riusa la tabella `photos`.

La ragione decisiva è il **purge worker** di ADR-020 §5: la sua fase 3 (orphan
sweep) cancella *ogni blob su disco privo di una riga `photos`*. Una foto del
locale non ha, né deve avere, una riga `photos` — quindi se condividesse lo
store dei blob delle spedizioni, lo sweep la cancellerebbe al primo giro. La
via a prova di errore è tenere i due mondi separati:

- **store diverso** (`VENUE_PHOTO_STORAGE_DIR`, default `./data/venue-photos`,
  o `PHOTO_STORAGE_S3_VENUE_BUCKET` con driver s3): il purge worker vede solo lo
  store delle spedizioni e non può toccare i blob del locale;
- **tabella diversa**: niente `shipment_id`/`taken_by`/`custody_event_id`/
  `purge_after` nullable a inquinare una tabella sensibile e la sua authz (tutta
  costruita attorno alla partecipazione a una spedizione). `hub_photos` ha solo
  ciò che serve.

Si riusa invece **tutto il resto** di ADR-020: l'interfaccia `BlobStore` e i
suoi driver (fs/s3, ADR-023), l'indirizzamento per contenuto (chiave = sha256),
lo strip EXIF + re-encode **sul dispositivo prima dell'hash** (il server
verifica hash, magic bytes JPEG e assenza di GPS EXIF, e non ri-encoda mai —
ADR-020 §2). L'unica differenza di contratto è l'**autorizzazione**: non c'è
catena di custodia da certificare (l'hub possiede le proprie foto) e la
**lettura è pubblica**.

Alternativa scartata — *riuso di `photos` con `hub_id` e `shipment_id`
nullable*: richiede rendere nullable una FK NOT NULL su una tabella sensibile,
un ramo di authz «pubblico» dentro rotte pensate per partecipanti, e un
`purge_after` fittizio lontano nel tempo per non farle sparire. Più codice sulla
superficie sbagliata, per unificare due cose che condividono solo i byte.

### 2. `photo_kind` guadagna `hub_venue` (solo in aggiunta)

L'enum Postgres si estende **solo in aggiunta** (trappola nota): si aggiunge
`hub_venue`, usato come `hub_photos.kind`. Non è dato come DEFAULT di colonna
nella stessa migrazione che lo aggiunge (Postgres vieta di *usare* un valore
enum nuovo nella stessa transazione che lo crea): la migrazione crea la colonna
`photo_kind NOT NULL` e l'app scrive `'hub_venue'` a runtime. Il `kind` tiene un
solo vocabolario delle foto e lascia spazio a sottotipi futuri (vetrina/interno)
senza un nuovo enum.

### 3. Visibilità pubblica, tetto piccolo

`GET /hubs/:id/venue-photos` (lista sha256) e
`GET /hubs/:id/venue-photos/:sha256` (i byte, `Cache-Control: public`) sono
**senza sessione**: la vetrina serve a *scegliere* una controparte, come il
rating dell'hub (CLAUDE.md). L'upload e la cancellazione sono del **solo
proprietario** (`POST`/`DELETE /hubs/mine/venue-photos/:sha256`). Tetto
`MAX_VENUE_PHOTOS = 6`: una vetrina, non un album. Le foto compaiono sulla card
dell'hub (`GET /hubs` porta gli sha256) e si gestiscono dalla dashboard.

Nessun purge: le foto del locale vivono e muoiono con l'hub. La cancellazione
account passa già da `DELETE /me`; una pulizia esplicita dei blob del locale
alla cancellazione dell'hub è un ritocco futuro (oggi l'hub non si cancella).

### 4. Email di contatto del locale, distinta e privata

`hubs.contact_email` (nullable). È l'indirizzo a cui arriva l'avviso di
deposito; se assente si usa l'email dell'account. **Non è mai esposta
pubblicamente** (minimizzazione, RISKS §6): serve solo come destinatario delle
notifiche, non come contatto pubblico del negozio.

### 5. Avviso di deposito via `email_outbox`, sulla richiesta reale

Quando si crea una spedizione il cui **hub di origine non auto-accetta** (o non
ha wallet connesso: in entrambi i casi la spedizione resta `DRAFT`, una vera
*richiesta* in attesa dell'azione dell'hub), si accoda un'email
`hub_deposit_request` all'hub — nella **stessa transazione** dell'inserimento
della spedizione (invariante outbox: nessuna mail per una spedizione non
creata). Un hub che **auto-accetta** non riceve l'avviso: non c'è nulla da
decidere, la custodia è già presa.

I numeri che decidono l'accettazione (bond, guadagno stimato con sats + €) sono
autorevoli sulla **dashboard**, dove l'hub accetta o rifiuta; la mail porta
l'essenziale (destinazione, giacenza richiesta, contenuto dichiarato o no) e il
link. Quando la Fase 2 punto 8 introdurrà la richiesta di deposito anche per
l'**hub di arrivo** di una tratta, quel flusso riuserà lo stesso template
`hub_deposit_request`.

## Conseguenze

- Deploy: nasce una nuova posizione di storage per i blob del locale
  (`VENUE_PHOTO_STORAGE_DIR` / `PHOTO_STORAGE_S3_VENUE_BUCKET`). In produzione va
  su un volume persistente separato da quello delle foto delle spedizioni
  (DEPLOY.md), altrimenti le foto del locale sparirebbero a ogni redeploy.
- Il purge worker delle spedizioni resta invariato e non può toccare i blob del
  locale: sono store diversi.
- La superficie di authz nuova (upload solo proprietario, lettura pubblica, cap,
  hash/EXIF come ADR-020) è testata con lo stesso rigore dei test foto
  (`hub-venue.e2e.test.ts`).
- Nessun movimento di denaro, ledger ed escrow non toccati.
