# ADR-018 — Web UI: proxy same-origin, importi sats-first solo dall'API, i18n a cookie

- Stato: accettato e implementato — 2026-07-14 (parte 1); esteso lo stesso
  giorno con le decisioni della parte 2 (§6); §5 chiuso lo stesso giorno con
  l'arrivo di `GET /me/shipments` e `GET /me/trips`
- Contesto: consegna della web UI (parte 1: fondamenta + flusso mittente e
  vettore; parte 2: hub, destinatario, recensioni, GDPR); ADR-002 (Next.js +
  API Fastify separata), ADR-008 (importi), ADR-009 (auth), ADR-015 (mappa),
  ADR-016 (claim), ADR-017 (recensioni)

## Contesto

La web UI consuma l'API pubblica come qualunque client terzo (ADR-002). Tre
questioni di piattaforma andavano decise alla prima riga di codice: come
parlare con l'API senza CORS, come trattare gli importi in una UI che non
deve MAI ricalcolare denaro (regola non negoziabile del progetto), e come
fare i18n "it default, en pronto" senza complicare le rotte.

## Decisioni

### 1. Proxy same-origin via rewrites di Next (niente CORS)

L'API non configura CORS, di proposito. Il web proxa ogni chiamata browser
attraverso una rewrite `/api/:path*` → `${API_URL}/:path*`
(`next.config.mjs`): stessa origin, quindi il cookie di sessione httpOnly
`mercurio_session` (ADR-009) viaggia senza attributi cross-site, senza
preflight e senza allargare la superficie dell'API. Le pagine server-rendered
(lista hub, stato pubblico da QR) chiamano l'API direttamente su `API_URL` —
le rewrites esistono solo per il browser. Alternative scartate:

- **CORS sull'API** (`Access-Control-Allow-Origin` + `credentials`): apre a
  ogni client browser terzo la possibilità di usare i cookie di sessione;
  la superficie pubblica dell'API è pensata per bearer token, non per
  sessioni cross-origin. Più configurazione per zero benefici sull'MVP.
- **BFF / API routes di Next**: duplicherebbe il contratto (ADR-002 lo vieta
  in spirito: il web deve usare la STESSA API pubblica).

### 2. Importi: sats-first, ogni numero nasce nell'API

La UI mostra e invoca; non esiste UNA conversione monetaria calcolata nel
client, con una sola eccezione dichiarata: il **controvalore € indicativo**,
reso da un unico componente (`Amount`) a partire dallo snapshot di cambio che
l'API allega all'importo (quello congelato della spedizione dove esiste —
ADR-008 — o quello corrente per i suggerimenti). Conseguenze concrete:

- Gli input di offerta, bond e tariffa minima sono **in sats** (mai ambigui,
  Bitcoin Design Guide); la conversione utente EUR→sats non esiste nel
  client.
- Per prefillare quegli input, gli endpoint dei suggerimenti restituiscono
  anche il lato msat calcolato dal server con lo snapshot corrente
  (`GET /shipments/suggested-offer` → `suggestedMsat` + `eurRate`;
  `GET /trips/suggested-rate` → `msatPerKm` + `eurRate`), con conversione
  intera al centesimo e floor al sat (`eurFloatToMsat`, testata).
- La card della bacheca porta lo **snapshot congelato** della spedizione
  (`boardCardDto.eurRate`): il € indicativo accanto al netto usa lo stesso
  cambio che governerà l'incasso del vettore, non il cambio di oggi.
- La "forbice" del suggerimento offerta (MATCHING §5) oggi è resa come copy
  qualitativa (valore consigliato + "offri di più per avere priorità"):
  l'API non espone ancora percentili storici — estensione futura, non un
  calcolo da fare nel client.

### 3. i18n: next-intl senza rotte localizzate, locale in cookie

`it` default, `en` completo, nessun prefisso URL: il locale vive nel cookie
`MERCURIO_LOCALE` letto dalla request config di next-intl; lo switcher nel
footer lo scrive e fa `router.refresh()`. Zero stringhe hardcoded: un unit
test percorre stati spedizione, tipi di evento di custodia e codici errore
API mappati e fallisce se uno dei due cataloghi è incompleto o se i due
alberi di chiavi divergono. Aggiungere rotte `/en/...` in futuro è un cambio
di routing, non di copy.

### 4. Dipendenze cartografiche e client-only

Leaflet + react-leaflet (ADR-015) caricati con `next/dynamic` `ssr: false`
(Leaflet tocca `window` all'import); tile OSM di default con attribution
corretta; nessun dato a Google prima del click sull'URL generata dal server.

### 5. Memoria locale del dispositivo — chiuso: `GET /me/shipments` e `GET /me/trips` (2026-07-14)

Fino a questo punto l'API non aveva `GET /me/shipments` né `GET /me/trips`:
la UI ricordava in `localStorage` gli id delle spedizioni create e l'ultimo
viaggio dichiarato (soli id e scadenze, niente importi né PII). I due
endpoint esistono ora — paginazione semplice offset/limit (`limit`/`offset`
in query, default 20, tetto 100, `@mercurio/shared` `listQuery`), risposta
`{ items, total, limit, offset }` con `meShipmentDto`/`meTripDto` — e la home
e `/carrier` leggono le spedizioni e i viaggi dall'account al posto del
dispositivo; `lib/recent.ts` è stato rimosso. Conseguenze:

- Le spedizioni tornano più recenti prima (`shipments.created_at`); i viaggi
  allo stesso modo, ma su una colonna nuova (`carrier_trips.created_at`,
  aggiunta con questo cambio): gli id sono UUID casuali, non ordinabili per
  tempo da soli.
- Un vettore ha un solo "viaggio attivo" mostrato in `/carrier`: il più
  recente per dichiarazione con `status = 'active'` e `expiresAt` non ancora
  scaduto — la stessa semantica "un solo viaggio alla volta" della vecchia
  memoria locale, solo letta dal server invece che dal browser.
- `GET /me/shipments` risolve i nomi hub (`originHubName`/`destHubName`) per
  la card nella home, non solo gli id.

### 6. Parte 2 — hub, destinatario, recensioni, GDPR (2026-07-14)

Decisioni di piattaforma emerse consegnando i flussi operativi; nessuna
tocca il protocollo dei pagamenti:

- **Foto = hash calcolati sul dispositivo.** L'API accetta sha256 dichiarati
  (ARCHITECTURE §5 precisazione 12): la UI li calcola con WebCrypto
  (`lib/photo-hash.ts`, testata sui vettori FIPS) da un input file/camera;
  le immagini non lasciano MAI il dispositivo. Un componente unico
  (`PhotoHashInput`) rende esplicito il comportamento all'operatore.
- **Campi QR tolleranti.** Il QR sul pacco codifica l'URL pubblica
  `/p/<qr_token>`: uno scanner incolla l'URL intera, un operatore digita il
  token nudo. Ogni campo QR accetta entrambe le forme (`parseQrInput`,
  testata) — l'API resta il giudice con `qr_mismatch`.
- **Link nelle email di ciclo vita, MAI credenziali nelle URL.** Le email al
  destinatario linkano `WEB_URL/track/:id`, quelle al mittente
  `WEB_URL/shipments/:id` (stessa variabile dei magic link). Le URL portano
  solo l'id della spedizione: token di claim e OTP restano nel corpo della
  mail come credenziali bearer e si incollano nella pagina (una URL finisce
  in history, log e referrer; un corpo mail no).
- **La pagina del destinatario è una sola** (`/track/:id`): prima del claim
  il destinatario non è partecipante (`GET /shipments/:id` → 404) e la
  pagina mostra il form di riscatto; dopo, la stessa pagina è il tracking
  vivo. Lo stato del claim (pendente/scaduto/attivo) si legge dalla catena
  di custodia (`claim_requested`/`funded`/`expired` — ADR-016 precisazione
  4): nessun endpoint nuovo.
- **La UI offre, l'API giudica.** Le pagine operative (hub/vettore) mappano
  stato+ruolo → azioni offerte, ma ogni guardia vera vive nell'API: i codici
  errore delle rotte di lifecycle e recensioni sono copy mappata nei
  cataloghi (il test di completezza li copre entrambi).
- **GDPR in UI**: export scaricato client-side (Blob, nessun terzo);
  cancellazione con conferma esplicita e copy onesta sull'anonimizzazione
  (il ledger e la catena di custodia restano, senza PII).

## Conseguenze

- Un solo posto in cui il denaro si formatta (`lib/format.ts` + `Amount`),
  testato; grep di controllo: nessun `*` o `/` su importi fuori da lì (le
  uniche operazioni ammesse sono ×1000 sats→msat come conversione di unità
  e il rendering del € indicativo).
- Il deploy del web richiede solo `API_URL`; l'API resta identica per i
  client terzi.
- I wallet fake (dev) si abilitano con `FAKE_WALLETS=true` sull'API: la
  rete Lightning finta vive in memoria nel processo — un riavvio dimentica
  saldi e hold pendenti (limite di sviluppo, documentato nel README web).
