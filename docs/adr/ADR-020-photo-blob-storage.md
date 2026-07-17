# ADR-020 — Foto: blob storage su filesystem content-addressed, EXIF rimosso sul dispositivo, accesso solo via API

- Stato: accettato e implementato — 2026-07-17
- Contesto: ADR-018 §6 (foto = hash dichiarati dal client), RISKS.md §1 (le foto
  sono la tutela documentale dei passaggi di mano) e §6 (retention limitata),
  ARCHITECTURE.md §5 precisazione 12, tabella `photos` già a schema

## Contesto

Fino a oggi le foto esistevano **solo come hash**: il client le hashava con
WebCrypto sul dispositivo e dichiarava gli sha256 all'API, che li scriveva
nella catena di custodia. Nessun byte veniva mai caricato: nessuna controparte
poteva _vedere_ una foto (contenuto, pacco sigillato, stato ai passaggi di
mano), il che svuota metà del valore documentale di RISKS.md §1. La tabella
`photos` (`storage_key`, `sha256`, `kind`, `purge_after`, FK a
shipments/custody_events/rejections) era pronta ma nessun codice la usava.

Il vincolo che governa ogni scelta qui sotto: **l'hash calcolato sul
dispositivo resta l'ancora di integrità**. Il server verifica i byte contro
l'hash certificato in catena; non lo ricalcola, non lo sostituisce, non altera
i byte (il contratto di `photo-hash.ts` e dei custody event non cambia).

## Decisioni

### 1. Interfaccia `BlobStore` minimale, driver filesystem content-addressed

Stesso pattern di `WalletConnection`/`DistanceProvider`: un'interfaccia
piccola (`put`, `get`, `delete`, `list`) e un driver di default. Il driver MVP
è il **filesystem locale, content-addressed**: chiave = sha256 (che è già la
chiave naturale dello schema), path `<dir>/<sha[0..1]>/<sha>`, scrittura
atomica (file temporaneo + rename), idempotente per costruzione (stessi byte ⇒
stessa chiave ⇒ stesso path). La directory è configurabile con
`PHOTO_STORAGE_DIR` (default `./data/photos`) ed è gitignorata.

Niente container né volumi Docker: il problema dei bind-mount root:root
appena documentato in ADR-004 non si pone. Un driver S3-compatibile (MinIO,
Garage) arriverà con un ADR futuro quando servirà più di una replica API:
l'interfaccia è il confine, la sostituzione non tocca le rotte.

Due righe `photos` possono referenziare lo stesso blob (stesso sha256 in due
eventi): la cancellazione fisica avviene solo quando sparisce l'ultima riga
che lo referenzia (refcount calcolato a query, mai denormalizzato).

### 2. EXIF: rimozione sul dispositivo, PRIMA dell'hash

Il conflitto da sciogliere: i metadati EXIF (geotag, seriale del dispositivo)
non devono arrivare al server (minimizzazione, RISKS.md §6), ma se il server
ri-encodasse l'immagine per rimuoverli i byte serviti non corrisponderebbero
più all'hash certificato in catena — e l'intero valore probatorio crollerebbe.

Decisione: **il re-encode avviene sul dispositivo, prima dell'hash**. Il
client decodifica la foto (`createImageBitmap` con orientamento EXIF
applicato), la ridisegna su canvas (ridimensionando a max 2048 px sul lato
lungo) e la ri-esporta in JPEG: il canvas non copia nessun metadato. Solo a
quel punto calcola lo sha256. Così **byte hashati == byte caricati == byte
serviti**, e in più gli upload restano piccoli su rete mobile.

Difesa in profondità server-side: l'upload **rifiuta** i JPEG che contengono
un GPS IFD EXIF (`photo_exif_gps`) — protegge da client terzi e da bug del
nostro, senza mai ri-encodare. Trade-off dichiarato: il server può solo
rifiutare, non ripulire; un client terzo che usa l'API pubblica deve fare lo
strip da sé (è documentato nell'OpenAPI). Gli hash dichiarati prima di questo
ADR restano validi in catena; semplicemente non avranno mai un blob.

### 3. Upload: dopo la certificazione, byte = hash dichiarato

`POST /shipments/:id/photos/:sha256`, body raw `image/jpeg` (whitelist MIME
verificata sui magic bytes, non sull'header), limite `PHOTO_MAX_BYTES` (5 MB).

L'ordine è **prima la transizione, poi l'upload**: un hash è caricabile solo
se già presente nel record certificativo della spedizione. Guardie, in ordine:

1. sessione autenticata e chiamante **partecipante** della spedizione
   (altrimenti 404, mai rivelare l'esistenza — come `GET /shipments/:id`);
2. lo sha256 dichiarato deve esistere nei payload `photoSha256` della catena
   di custodia oppure in `checkoutPhotoSha256` della tratta attiva (doppia
   conferma pendente: l'hub ha confermato, il vettore non ancora) — altrimenti
   422 `photo_not_certified`;
3. chi carica deve essere il **fotografo dichiarato** di quell'evento (tabella
   sotto) — altrimenti 403 `photo_not_photographer`;
4. sha256 dei byte ricevuti == `:sha256` — altrimenti 422 `photo_hash_mismatch`;
5. magic bytes JPEG (`photo_format_unsupported`) e assenza di GPS EXIF
   (`photo_exif_gps`).

La riga `photos` nasce con `kind` mappato dal tipo evento, `custody_event_id`
linkato quando l'evento esiste (null solo per il checkout pendente),
`taken_by` = uploader, `purge_after` = upload + 90 giorni (tetto — vedi §5).
Ricaricare lo stesso hash è idempotente (200). Se l'upload fallisce dopo la
transizione la certificazione resta valida — è esattamente lo stato dell'arte
pre-ADR (hash senza byte) — e il client può ritentare finché ha il file.

| Evento in catena                                 | `kind`     | Fotografo autorizzato                                                                       |
| ------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| `hub_checkin`                                    | `checkin`  | hub d'origine (actor dell'evento)                                                            |
| `hub_checkout` (anche doppia conferma pendente)  | `checkout` | hub di partenza della tratta (l'actor dell'evento è il **vettore**, ma le foto le dichiara l'hub) |
| `hub_checkin_intermediate` / `arrived_destination` | `checkin`  | hub d'arrivo (actor)                                                                         |
| `leg_returned`                                   | `checkin`  | hub di partenza (actor)                                                                      |
| `handoff_rejected`                               | `evidence` | chi ha rifiutato (actor)                                                                     |
| `created` (chiavi `contentPhotoSha256`/`sealedPhotoSha256`) | `content` / `sealed` | mittente (actor) — foto alla creazione, ADR-022                                   |

### 4. Visualizzazione: solo via API, con la sessione — la mappa authz

`GET /shipments/:id/photos` (elenco: sha256, kind, evento, data) e
`GET /shipments/:id/photos/:sha256` (i byte, `Content-Type: image/jpeg`,
`Cache-Control: private`). **Mai URL pubbliche o firmate**: l'authz vive nella
sessione a ogni richiesta, come per tutto il resto dell'API (stessa ragione
per cui token e OTP non entrano nelle URL — ADR-018 §6).

Chi vede che cosa, e da quando:

| Chi                                                        | Vede                          | Da quando                          |
| ---------------------------------------------------------- | ----------------------------- | ---------------------------------- |
| Mittente                                                   | tutte le foto della spedizione | sempre                             |
| Proprietario di ogni hub coinvolto (origine, destinazione, di tratta, correnti) | tutte                         | da quando l'hub entra nell'aggregato |
| Vettore di ogni tratta (anche pending o conclusa)          | tutte                         | da `leg_accept`                    |
| Claimant (ADR-016)                                         | tutte                         | dalla richiesta di claim           |
| Destinatario **senza** claim                               | niente                        | — (la pagina /track mostra solo lo stato) |
| Chi inquadra il QR (`GET /shipments/by-qr`)                | niente                        | —                                  |
| Non-parte                                                  | 404                           | —                                  |

Razionale della granularità "tutte o niente": le foto ritraggono il **pacco**
(nessun volto è richiesto dal flusso, RISKS.md §6); i partecipanti vedono già
tutti gli hash nella catena via `GET /shipments/:id`; e chi sta per ricevere
il pacco deve poter confrontare lo stato certificato ai passaggi precedenti
per decidere se accettare o rifiutare (RISKS.md §1 — la responsabilità segue
la custodia certificata). Una matrice per-foto sarebbe più codice authz senza
un caso d'uso che la richieda.

Alla domanda "destinatario via claim token?": **sì, ma solo dopo il claim e
con la propria sessione** — il claim lo rende partecipante (ADR-016), e da lì
vede le foto come gli altri. Il token in sé non autorizza nulla qui: la mail
di tracking non deve diventare una credenziale d'accesso alle foto.

### 5. Retention e purge (worker pg-boss, ADR-011)

Cron giornaliero (stesso processo API, come gli altri worker) in due fasi:

1. per le spedizioni in **stato terminale**, stringe
   `purge_after := min(purge_after, chiusura + 30 giorni)` — dove "chiusura" è
   il `created_at` dell'ultimo evento di custodia. È la regola di RISKS.md §6
   ("chiusura spedizione + 30 giorni") resa meccanica; `purge_after` resta
   l'unica verità ispezionabile su quando una foto morirà.
2. cancella le righe con `purge_after < now`: prima la riga, poi il blob se
   nessun'altra riga lo referenzia ancora.

Il tetto di 90 giorni dall'upload (impostato alla nascita della riga) copre le
spedizioni che non chiudono mai. Uno **sweep degli orfani** completa il
quadro: i blob su disco senza riga corrispondente e più vecchi di 24 ore
vengono rimossi (copre i crash tra scrittura del blob e insert della riga, e
tra delete della riga e unlink del blob).

### 6. GDPR: cancellazione account

`DELETE /me` cancella **subito** righe e blob delle foto scattate dall'utente
(`taken_by`) per le spedizioni già chiuse; le foto di spedizioni ancora in
corso restano fino al purge naturale del §5 — sono la tutela documentale delle
controparti in una custodia in corso (interesse legittimo, durata comunque
limitata dal §5). Gli hash nella catena di custodia restano, come previsto:
la catena è append-only e senza PII (RISKS.md §6).

## Alternative considerate

- **S3/MinIO subito**: un servizio stateful in più per l'MVP contro il
  principio "un solo servizio stateful" (ADR-011); l'interfaccia `BlobStore`
  rende il passaggio una sostituzione di driver, non un refactoring. Rimandato
  a un ADR futuro.
- **Strip EXIF server-side (ri-encode)**: il server servirebbe byte diversi da
  quelli certificati in catena — l'ancora di integrità si rompe. Scartato: il
  punto dell'intero sistema è che nessuno, piattaforma inclusa, possa alterare
  ciò che è stato certificato.
- **Hash sull'originale, upload dell'originale (EXIF compreso)**: i geotag
  arriverebbero al server; per le future foto del mittente (`content`/`sealed`)
  rivelerebbero casa sua. Scartato per minimizzazione.
- **URL firmate / pubbliche**: spostano l'authz su un secondo meccanismo e
  possono sopravvivere in history, log e referrer. Scartato.
- **Upload prima della transizione**: righe orfane a ogni transizione fallita
  (`qr_mismatch`, guardie) e authz torbida (a quale evento si aggancia un blob
  non ancora certificato?). Scartato: prima la certificazione, poi i byte.

## Conseguenze

- Può esistere un hash certificato senza blob (upload fallito o mai fatto,
  client terzi, storia pre-ADR): la UI mostra le foto disponibili e non
  promette le altre. Non può esistere un blob "certificato" senza hash in
  catena.
- `PHOTO_STORAGE_DIR` entra nella configurazione di deploy; più repliche API
  richiederanno il driver condiviso (ADR futuro).
- I test di authz su upload/download (non-parte → 404, non-fotografo → 403,
  hash non certificato → 422) sono trattati col rigore dei test di denaro:
  è la superficie sensibile di questa feature.
- Il purge rende misurabile la promessa di retention di RISKS.md §6: ogni
  foto ha una data di morte leggibile in tabella.
