# ADR-022 — Foto del mittente alla creazione (`content`/`sealed`): certificazione nell'evento `created`, upload con le guardie di ADR-020

- Stato: accettato e implementato — 2026-07-17
- Contesto: CLAUDE.md flusso punto 1 ("foto opzionali del contenuto e/o del
  pacco sigillato"), ADR-020 §3 (la riga "riservati" della tabella dei
  fotografi: il form Spedisci non aveva la cattura), ADR-018 §6 (foto = hash
  calcolati sul dispositivo), RISKS.md §1 (le foto come tutela documentale)

## Contesto

ADR-020 ha consegnato l'intera pipeline delle foto — upload verificato contro
l'hash certificato, download con authz di sessione, purge GDPR — ma solo per i
kind legati ai passaggi di mano (`checkin`, `checkout`, `evidence`). I due
kind del mittente, `content` (il contenuto prima di sigillare) e `sealed` (il
pacco sigillato), erano riservati: esistevano nell'enum e nel catalogo copy,
ma nessun modo di dichiararli né di caricarli.

Il nodo da sciogliere: **alla creazione non esiste un passaggio di mano**. Le
certificazioni fotografiche di ADR-020 vivono nei payload della catena di
custodia, agganciate all'evento che documenta chi prende o cede il pacco; il
mittente che fotografa le penne sul tavolo di casa non sta cedendo la custodia
a nessuno. Dove vive allora la certificazione dei suoi hash?

## Decisione

### 1. La certificazione vive nel payload dell'evento `created`

L'osservazione che rende tutto lean: **la transizione `create` appende già un
evento di catena** — `created`, actor = mittente, payload con hub, offerta e
bond. È il record certificativo della spedizione per eccellenza: genesi della
catena hash-linked, immutabile, visibile a ogni partecipante via
`GET /shipments/:id`.

`createShipmentBody` guadagna due campi **opzionali** (le foto restano
facoltative, CLAUDE.md punto 1), validati come ogni altra lista di hash
(`photoHashesSchema`, max 10, sha256 esadecimale minuscolo):

- `contentPhotoSha256` → kind `content`
- `sealedPhotoSha256` → kind `sealed`

La rotta li passa all'evento `create` della macchina a stati, che li copia nel
payload di `created` **con le stesse chiavi distinte** (presenti solo se non
vuote: il payload delle spedizioni senza foto resta byte-per-byte quello di
prima). Chiavi distinte e non il generico `photoSha256` perché qui il kind non
è deducibile dal tipo evento: un solo evento certifica due kind diversi.

Regola di ADR-020 preservata: **i payload della catena sono le
certificazioni**. Nessuna seconda casa per gli hash, nessuna migration (il
payload è già jsonb), tamper-evidence gratis dal concatenamento degli hash
di catena.

### 2. Upload: stessa rotta, guardie 2 e 3 estese

`POST /shipments/:id/photos/:sha256` non cambia contratto. Delle cinque
guardie di ADR-020 §3:

- la **2** (hash certificato) ora trova l'hash anche nelle chiavi
  `contentPhotoSha256`/`sealedPhotoSha256` dell'evento `created`, che
  determinano il kind della riga `photos`;
- la **3** (fotografo dichiarato) per `content`/`sealed` richiede l'actor
  dell'evento, cioè il **mittente** — la tabella di ADR-020 §3 perde la riga
  "riservati" e guadagna la riga `created`;
- 1, 4 e 5 (partecipante, byte == hash, JPEG senza GPS EXIF) valgono identiche.

Caso d'angolo dichiarato: lo stesso hash in entrambe le liste prende il kind
della prima trovata (`content`). Innocuo — il kind è metadato di
visualizzazione, l'authz e la retention non ne dipendono.

### 3. Visibilità e UI: la matrice di ADR-020 §4 non cambia

I partecipanti vedono tutto, i non-parte 404: le foto di creazione non
introducono granularità nuova. In UI:

- il form Spedisci monta due `PhotoHashInput` opzionali (contenuto / pacco
  sigillato): re-encode e hash sul dispositivo (ADR-020 §2), dichiarazione
  degli hash nella `POST /shipments`, upload dei byte **dopo** la creazione
  riuscita (pattern di `HubOpsClient`: un upload fallito non invalida nulla,
  la certificazione resta e il client può ritentare);
- la galleria della pagina operazioni hub mostra i nuovi kind senza alcuna
  modifica (etichette `photoKinds.content`/`sealed` già in catalogo);
- le timeline di dettaglio e tracking rendono le miniature sull'evento
  `created` come già fanno per gli altri eventi (le chiavi nuove si sommano a
  `photoSha256` nella raccolta degli hash dell'evento).

### 4. Retention e GDPR: ADR-020 §5–6 valgono identici

`purge_after` nasce a upload + 90 giorni (tetto) e viene stretto a
chiusura + 30 giorni dal worker quando la spedizione è terminale. Le foto di
creazione sono tipicamente le più vecchie della spedizione ma non servono
regole nuove: una spedizione che non parte mai muore comunque nel tetto dei
90 giorni, una che chiude porta con sé anche le foto del mittente. La
cancellazione account (`taken_by` = mittente) le rimuove subito per le
spedizioni chiuse, come ogni altra foto.

### 5. `undeclared` e foto del contenuto restano indipendenti

Nessun vincolo incrociato: `undeclared` governa la **policy di accettazione**
degli hub (chi accetta pacchi a contenuto non dichiarato), la foto è la
**tutela documentale** del mittente (RISKS.md §1). Un mittente può non
dichiarare il contenuto nel testo e comunque fotografarlo per sé — le foto le
vedono solo i partecipanti, non la bacheca.

### 6. OpenAPI: lo strip EXIF diventa contratto scritto

I client terzi devono sapere che il re-encode/strip EXIF è **a loro carico**
(il server rifiuta con `photo_exif_gps`, non ripulisce — ADR-020 §2): la rotta
di upload guadagna una `description` OpenAPI che lo dice per tutti i kind, e i
due campi nuovi di `createShipmentBody` portano la stessa avvertenza nel
proprio `describe()`.

## Alternative considerate

- **Colonne jsonb su `shipments`** (come `legs.checkout_photo_sha256`):
  richiede una migration e crea una seconda casa *permanente* per le
  certificazioni fuori dalla catena. Il precedente della tratta è transitorio
  (alla doppia conferma gli hash confluiscono nel payload di `hub_checkout`);
  qui l'evento di catena esiste già al momento giusto. Scartata.
- **Un nuovo tipo di evento di custodia** (`photos_declared`) appendibile
  anche dopo la creazione: cambia la grammatica della catena (ogni consumer
  sa che `created` è la genesi) per un requisito che non c'è — le foto del
  mittente hanno senso solo prima che il pacco lasci le sue mani; dopo, lo
  stato è certificato dai passaggi di mano. Scartata.
- **Rotta di upload dedicata alle foto di creazione**: duplicherebbe guardie
  e idempotenza che ADR-020 §3 già generalizza. Scartata.
- **Foto obbligatorie alla creazione**: contro CLAUDE.md (esplicitamente
  opzionali) e inutilmente ostile al mittente da telefono scarso. Scartata.

## Conseguenze

- Il flusso del mittente è completo end-to-end: dichiara alla creazione,
  carica, le controparti vedono (hub in galleria, tutti nelle timeline).
- La macchina a stati trasporta due campi opzionali in più nell'evento
  `create`; nessuna guardia nuova (le foto sono facoltative), nessun effetto
  su denaro o timeout.
- `findCertification` in `photos.ts` gestisce il caso `created`; i test
  authz (mittente ok, partecipante non-mittente 403, hash non dichiarato 422,
  idempotenza, non-parte 404) sono trattati col rigore dei test di denaro,
  come per gli altri kind.
- Gli hash dichiarati sono visibili nella catena dal momento zero: un hub può
  confrontare il pacco consegnato al check-in con la foto `sealed` del
  mittente prima di certificare l'integrità.
