# ADR-018 — Web UI: proxy same-origin, importi sats-first solo dall'API, i18n a cookie

- Stato: accettato e implementato — 2026-07-14
- Contesto: prima consegna della web UI (fondamenta + flusso mittente e
  vettore); ADR-002 (Next.js + API Fastify separata), ADR-008 (importi),
  ADR-009 (auth), ADR-015 (mappa)

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

### 5. Memoria locale del dispositivo (limite dichiarato)

L'API non ha ancora `GET /me/shipments` né `GET /me/trips`: la UI ricorda in
`localStorage` gli id delle spedizioni create e l'ultimo viaggio dichiarato
(soli id e scadenze, niente importi né PII). Quando la parte 2 aggiungerà gli
endpoint di lista, questa memoria sparisce.

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
