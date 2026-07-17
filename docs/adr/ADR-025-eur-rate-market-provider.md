# ADR-025 — Cambio EUR→sats reale: mediana di ticker pubblici, cache in processo, fisso solo per dev

- Stato: accettato e implementato — 2026-07-17
- Contesto: ADR-008 (importi in msat, EUR solo input/display, cambio
  fotografato alla creazione e congelato per la vita della spedizione — è la
  decisione che questo ADR realizza), ADR-011 (job e cron su pg-boss nel
  processo API), ADR-013 (zero custodia), ADR-024 (deploy: una replica, segreti
  solo da env)

## Contesto

ADR-008 aveva già deciso la sostanza — «Fonte cambio: **mediana di più provider
con cache**; la fonte è registrata nello snapshot» — ma l'MVP ha implementato un
segnaposto: un tasso fisso da env, `EUR_RATE_SATS_PER_EUR`, default **1600
sats/€**, che è la scala dell'esempio canonico (5 € ≈ 8000 sats) e non un
prezzo. Sensato finché si girava su regtest, dove i sats non hanno prezzo di
mercato. Con ADR-024 quel segnaposto è finito in produzione, dove diventa **un
numero che qualcuno deve aggiornare a mano ricreando il container** — e che
nessuno aggiornerà.

Quanto è sbagliato oggi: 1600 sats/€ equivale a 62 500 €/BTC. Il 2026-07-17 le
tre fonti scelte qui sotto quotavano ~55 007 €/BTC, cioè ~1818 sats/€ (misurato,
non stimato: §Conseguenze). Il segnaposto **sbaglia di circa il 12%**, e
sbaglierà di più ogni giorno che passa. In concreto, sul tetto ToS dei 1000 €:
1 600 000 000 msat contro i 1 817 933 752 msat del cambio vero.

Cosa governa quel numero:

- **il tetto ToS del bond**: `MAX_CUSTODY_BOND_EUR` (1000 €) è convertito in
  msat al cambio dello snapshot (`routes/shipments.ts`). Un cambio del 12% più
  basso è un tetto del 12% più stretto di quello che i ToS promettono;
- **i suggerimenti** di offerta e di tariffa €/km (ADR-018 §2: l'API restituisce
  `suggestedMsat`/`msatPerKm`, il client non converte mai);
- **il controvalore € indicativo** mostrato ovunque accanto ai sats.

### Il vincolo che decide tutto il resto: dove serve uno snapshot *nuovo*

Prima di scegliere una politica d'errore è stato verificato **dove il provider
viene davvero interrogato**. `app.eurRate.snapshot()` ha esattamente tre punti
di chiamata:

| Punto di chiamata                   | A cosa serve                                     | Il valore si congela? |
| ----------------------------------- | ------------------------------------------------ | --------------------- |
| `POST /shipments`                   | Tetto ToS del bond + snapshot scritto sulla riga | **Sì, per sempre**    |
| `GET /trips/suggested-rate`         | `msatPerKm` suggerito                            | No, è un consiglio    |
| `GET /trips/:id/suggested-offer`    | `suggestedMsat` suggerito                        | No, è un consiglio    |

Tutto il resto — release/refund, check-in/check-out, ritiri, claim già
finanziati, card della bacheca, dettaglio spedizione — legge la colonna
**congelata** `shipments.eur_rate_snapshot`, mai il provider. È una proprietà
strutturale, non una gentilezza: **un feed giù non può bloccare denaro in volo**,
perché nessun flusso di denaro chiede un cambio nuovo. Ed è ciò che rende
sostenibile una politica severa dove il valore si congela: rifiutare una
creazione costa un «riprova tra un minuto» con zero fondi impegnati.

## Decisioni

### 1. Fonte: mediana di più ticker pubblici, senza chiave, solo server-side

| Opzione                                                   | Pro                                                                                                        | Contro                                                                                                                                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Una sola API pubblica senza chiave                     | Un fetch, un parser, latenza minima, niente quorum da ragionare                                            | Nessuna corroborazione: se quel feed sbaglia in modo *plausibile* (campo rinominato, pair illiquido, errore di unità) il numero sbagliato si congela e i bounds non lo vedono |
| B. Un aggregatore (CoinGecko, CoinCap)                    | Una chiamata sola, la media la fanno loro                                                                  | La loro mediazione è opaca e non verificabile; il free tier vuole una chiave e limita duramente; è un terzo in più di cui fidarsi ciecamente                                  |
| **C. Mediana di N ticker pubblici** _(scelta)_            | Un feed rotto o bugiardo è l'outlier e la mediana lo scarta; nessuna chiave; nessun aggregatore in mezzo   | Tre parser da mantenere (schema drift); serve definire un quorum                                                                                                              |

Scelta **C** — che è poi ciò che ADR-008 aveva già deciso. La ragione decisiva è
il tipo di guasto da cui difendersi: non «il feed è giù» (visibile, gestito dalla
cache), ma **«il feed risponde un numero plausibile e sbagliato»**. Quello lo
prende solo la corroborazione.

Le tre fonti di default — tutte GET pubbliche, senza chiave, senza registrazione:

| Nome       | Endpoint                                                | Campo letto        |
| ---------- | ------------------------------------------------------- | ------------------ |
| `kraken`   | `api.kraken.com/0/public/Ticker?pair=XBTEUR`            | `result.*.c[0]`    |
| `bitstamp` | `www.bitstamp.net/api/v2/ticker/btceur/`                | `last`             |
| `coinbase` | `api.coinbase.com/v2/prices/BTC-EUR/spot`               | `data.amount`      |

**Nessun dato utente esce**: sono tre GET senza parametri, senza corpo e senza
identificatori, fatte dal processo API. Il browser non contatta mai un exchange
(sarebbe anche una fuga di dati: l'IP dell'utente al terzo). Nessuna chiave ⇒
nessun segreto nuovo nella superficie di ADR-024 §6.

**Quorum: almeno 2 risposte valide.** Con tre fonti si tollera che una sia giù o
rotta. Con una sola risposta non c'è corroborazione — cioè manca esattamente la
proprietà per cui si è scelta la mediana — e il refresh fallisce (si ricade sulla
cache, §5). Per lo stesso motivo il provider **rifiuta di costruirsi** con meno
fonti del quorum: `EUR_RATE_SOURCES=kraken` da solo non è una configurazione
degradata, è la mediana disattivata di nascosto.

**Mediana con n pari: si prende il valore mediano inferiore**, non la media dei
due centrali. Così il cambio congelato è sempre un prezzo che **una fonte ha
davvero quotato** (verificabile ex-post contro lo storico di quell'exchange)
invece di un numero che nessuno ha mai pubblicato; e nella direzione conservativa
per il tetto ToS (meno sats/€ ⇒ tetto più stretto).

### 2. Le fonti si scelgono per nome, non per URL

`EUR_RATE_SOURCES=kraken,bitstamp,coinbase` seleziona fra le fonti **note al
codice**. Un URL arbitrario da env è stato scartato: un endpoint senza il suo
parser è inutilizzabile — servirebbe configurare anche la forma della risposta
(un JSONPath in una env: un linguaggio di configurazione che nessuno vuole
debuggare alle 3 di notte) — e un env sbagliato punterebbe il fetch a un host
che un attaccante controlla, cioè lascerebbe scegliere il prezzo a lui. Aggiungere
una fonte è un parser di quattro righe e una riga di tabella: è una modifica di
codice, che è la sede giusta per «di chi ci fidiamo per il prezzo».

### 3. Conversione: matematica intera, la parte già testata non si tocca

Gli exchange quotano **EUR per BTC**; a noi serve **sats per EUR**. La
conversione è intera, mai float:

```
satsPerEur = 10^8 / eurPerBtc          →  con 8 decimali, in bigint:
S8 = 10^24 / (eurPerBtc × 10^8)        →  troncato, formattato "1820.53012797"
```

Il prezzo arriva **come stringa decimale** da tutte e tre le fonti (verificato) e
resta una stringa fino al `BigInt`: non passa mai per `Number`, dove
`0.1 + 0.2` insegna cosa succede ai soldi. Il troncamento è alla ottava cifra
decimale di sats/€ (~10⁻⁸ sats) e va verso il basso: un pelo conservativo sul
tetto ToS, invisibile altrove.

`eurToMsat` / `eurFloatToMsat` / `msatPerEur` in `lib/eur-rate.ts` **non
cambiano**: il provider produce la stessa `satsPerEur` stringa che producevano
prima, nel formato che la colonna `numeric(18,8)` accetta. Il confine
`EurRateProvider` era stato messo lì per questo ed è bastato.

Controprova aritmetica, utile come pietra di paragone: 62 500 €/BTC dà
esattamente 1600.00000000 sats/€, cioè il segnaposto storico.

### 4. Sanity bounds: rete grossolana in codice, non in env

Un valore fuori da **[1 000, 10 000 000] €/BTC** viene scartato *per quella
fonte* (non è un prezzo nuovo: è un feed rotto). Prende zero, negativi, `null`,
`"N/A"`, il campo sbagliato, l'errore di unità grossolano.

Divisione del lavoro da tenere chiara:

- i **bounds** sono la rete grossolana: deliberatamente lontanissimi da qualunque
  mercato plausibile, **non sono un'opinione sul prezzo**;
- la **mediana** è la rete fine: prende l'errore *dentro* i bounds (il classico
  ×100 da centesimi/euro, che a 54 900 €/BTC darebbe 5,49 M€/BTC — dentro il
  bound massimo, e infatti a fermarlo è la mediana, non il bound).

Sono **costanti nel codice, non env**: se un bound un giorno stringesse davvero,
allargarlo dev'essere una modifica rivista in PR, non una env cambiata di corsa
sull'host mentre si guarda un grafico. Con un intervallo così largo il caso è
lontano anni.

### 5. Cache e staleness: TTL 5 minuti, e la severità solo dove si congela

- **TTL 5 min**: entro cinque minuti il valore in cache si serve così com'è.
- **`at` è l'istante dell'osservazione, non della richiesta.** Servendo un valore
  in cache, `at` resta quando il prezzo è stato letto: una spedizione congela
  quindi un `eur_rate_at` che può precedere il suo `created_at`. È voluto — dice
  la verità su quanto era vecchio il prezzo che governa quel contratto.
- **Età massima 6 ore, e vale solo per `POST /shipments`.** Oltre, la creazione
  fallisce con `503 eur_rate_unavailable` (+ `Retry-After`), errore tipizzato
  come tutti gli altri.
- **I due endpoint di suggerimento accettano la cache a qualunque età** e
  falliscono solo se la cache è *vuota* (avvio a freddo con il feed giù).

L'asimmetria è il punto di tutto l'ADR ed è il motivo per cui il gate esiste: un
cambio congelato **è irreversibile e governa una spedizione per tutta la vita**
(ADR-008); un suggerimento è un consiglio che l'utente può ignorare e riscrivere,
e sotto ha comunque un input sats-first. Applicare la severità dove la sua
ragione non esiste sarebbe cerimonia. Rifiutare una creazione, invece, costa
poco proprio per il vincolo del §Contesto: nessun fondo è ancora impegnato, il
mittente riprova tra un minuto, e **nessun flusso già finanziato può inciampare
qui** — non chiedono un cambio nuovo.

Perché 6 ore: in sei ore BTC si muove realisticamente di qualche punto
percentuale, e un errore di quell'ordine su un tetto di 1000 € o su un'offerta
di 5 € è irrilevante. Sei ore sono invece molto più di qualunque interruzione
credibile di **tre exchange indipendenti**: se si superano, ciò che è rotto è
sistemico (i parser tutti insieme dopo un cambio di schema, l'egress dell'host
bloccato) e congelare in un contratto un prezzo di ieri è peggio che dire al
mittente di riprovare.

### 6. Il refresh gira on-demand, con cache in processo — niente cron

Alternativa considerata seriamente: un cron pg-boss (ADR-011), come per i timer e
l'outbox. Scartata:

- **Il cron di ADR-011 esiste per ciò che deve accadere *senza* una richiesta**
  (una giacenza scade anche se nessuno guarda). Il cambio serve **solo** a
  servire una richiesta: un cron lo aggiornerebbe tutta la notte per nessuno.
- **Da solo sarebbe pure peggio**: a processo appena avviato la cache è vuota
  fino al primo tick, quindi ogni deploy produrrebbe minuti di `503` sulla
  creazione — a meno di aggiungere comunque il fetch on-demand come fallback.
  Due meccanismi per il lavoro di uno.
- Una replica sola (ADR-024 §3) ⇒ una cache sola, nessun problema di coerenza,
  nessuna tabella nuova, nessuna migrazione, nessun job.

Il refresh è **single-flight**: le richieste concorrenti che trovano la cache
scaduta condividono un solo giro di fetch, non uno a testa.

Conseguenze accettate, dette qui perché non siano sorprese: la cache **non
sopravvive al riavvio** (la prima richiesta dopo un deploy paga ~300 ms di
fetch), e durante un'interruzione totale del feed ogni richiesta ritenta (niente
backoff negativo: a volumi MVP i tentativi sono cadenzati da esseri umani che
creano spedizioni e comunque limitati dal rate limit globale — tre endpoint
pubblici non se ne accorgono). Se un giorno servissero più repliche, un valore
che sopravvive ai riavvii o un backoff, l'aggancio è ADR-011 e il confine
`EurRateProvider` non cambia: è esattamente il punto di averlo.

### 7. Selezione da env, e in produzione nessun cambio può venire da un default

`EUR_RATE_PROVIDER` sceglie il provider — stesso schema di
`PHOTO_STORAGE_DRIVER` (ADR-023 §2):

| Valore             | Provider                                                                 |
| ------------------ | ------------------------------------------------------------------------ |
| `fixed` _(default)_ | Tasso fisso da `EUR_RATE_SATS_PER_EUR` (default 1600), `source: env-fixed` |
| `market`           | Mediana dei ticker di `EUR_RATE_SOURCES`, `source: median(bitstamp,coinbase,kraken)` |

**Il default resta `fixed`**: sviluppo, regtest, CI e test non toccano internet
per costruzione, e i sats di regtest non hanno un prezzo di mercato (ADR-008).
Non è ripiego: è la scelta giusta lì.

In produzione vale una regola sola: **nessun cambio può venire da un default**.
`assertProductionSafeEnv` (ADR-024, dov'è già il rifiuto di `FAKE_WALLETS`)
rifiuta l'avvio se `NODE_ENV=production` e:

- `EUR_RATE_PROVIDER` non è impostata — il default sarebbe il tasso fisso di
  sviluppo, cioè si andrebbe in produzione col segnaposto per distrazione; oppure
- `EUR_RATE_PROVIDER=fixed` senza un `EUR_RATE_SATS_PER_EUR` esplicito — sarebbe
  1600 sats/€, la scala dell'esempio canonico, a dimensionare il tetto ToS e a
  congelarsi in ogni spedizione.

`fixed` **con** un tasso esplicito resta invece permesso in produzione, ed è
deliberato: è la via d'uscita del giorno in cui gli schemi di tutte le fonti
cambiassero insieme — si fissa un numero a mano, consapevolmente, e si continua a
creare spedizioni mentre si sistema il parser. Vietarlo avrebbe lasciato come
unica risposta a un guasto del feed «non si spedisce».

Rifiutare l'avvio invece di avvisare segue il precedente di `FAKE_WALLETS`: un
avviso all'avvio lo legge chi guarda i log nel momento giusto, e il costo qui non
è teorico — un cambio sbagliato del 12% sposta il tetto ToS e i sats che il
mittente impegna senza che nulla sembri rotto.

## Alternative considerate

- **Tenere il tasso fisso e ricordarsi di aggiornarlo.** È lo stato attuale: un
  compito manuale, ricorrente, silenzioso quando salta, su un numero che dimensiona
  un tetto contrattuale. Nessun avviso quando è sbagliato, perché non c'è niente
  con cui confrontarlo.
- **Ricalcolare al cambio corrente durante il viaggio** invece di congelare:
  già scartata da ADR-008 e non riaperta — le quote delle tratte cambierebbero a
  metà spedizione. Lo snapshot congelato resta congelato.
- **Gate sulla dispersione fra le fonti** (rifiutare se disaccordano oltre l'x%):
  aggiunge una manopola che fallisce chiusa proprio durante la volatilità vera,
  cioè quando serve creare spedizioni come sempre. Mediana + bounds coprono già
  il guasto vero; la dispersione punirebbe il mercato per essere un mercato.
- **Persistere l'ultimo cambio in tabella** per sopravvivere ai riavvii: una
  migrazione e una tabella per risparmiare ~300 ms dopo ogni deploy. Se un
  domani si volesse (o servissero più repliche), non cambia niente al confine.
- **Bounds ed età massima configurabili da env**: quattro manopole in più che
  nessuno sa tarare meglio dei default, e le due che contano proteggono da guasti
  di cui l'operatore non ha più contesto di chi ha scritto il parser.

## Conseguenze

- In produzione il cambio EUR→sats viene da un mercato vero e si aggiorna da solo:
  sparisce il compito manuale, e con esso il tetto ToS che sbaglia in silenzio.
- **Verificato contro gli endpoint veri** (2026-07-17, `dist/` compilata, la
  stessa che gira in produzione — la suite non tocca la rete per scelta, quindi
  che i parser funzionino dal vivo è un fatto da controllare una volta a mano):
  le tre fonti hanno risposto 55 002,60 / 55 018,98 / 55 007,505 €/BTC, la
  mediana ha preso quella di mezzo ⇒ `1817.93375285` sats/€, `source`
  `median(bitstamp,coinbase,kraken)`; con un host morto iniettato il quorum di
  due ha risposto lo stesso, registrando `median(coinbase,kraken)`.
- **Il fetch di rete entra nel processo API** per la prima volta (finora usciva
  solo verso i relay NWC degli utenti, ADR-019). Superficie: tre GET pubbliche,
  senza chiave, senza dati utente, con timeout, verso host che ora vanno
  raggiungibili dall'egress dell'host di produzione.
- **`POST /shipments` può fallire con 503** — un esito nuovo per quel percorso,
  documentato in OpenAPI dal messaggio tipizzato. Gli altri percorsi no: leggono
  la colonna congelata (§Contesto).
- I parser sono la parte fragile: uno schema che cambia fa uscire quella fonte
  dal quorum, silenziosamente e senza conseguenze finché le altre due
  rispondono. Se ne perdessero due, la creazione si fermerebbe dopo 6 ore — il
  sintomo è rumoroso, ed è il punto.
- La superficie di configurazione di ADR-024 cresce di `EUR_RATE_PROVIDER` e
  `EUR_RATE_SOURCES`: **nessuna delle due è un segreto**, e ADR-024 non cambia.
