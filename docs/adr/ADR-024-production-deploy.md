# ADR-024 — Deploy di produzione: immagini OCI, compose su singolo VPS, Caddy come unica origin

- Stato: accettato e implementato — 2026-07-17
- Contesto: ADR-002 (web Next.js e API Fastify separate), ADR-011 (un solo
  servizio stateful — Postgres — e worker pg-boss nel processo API), ADR-013
  (zero custodia: la piattaforma non ha nodi Lightning), ADR-018 (proxy
  same-origin web→API), ADR-020 e ADR-023 (foto: driver fs di default,
  `PHOTO_STORAGE_DIR` da persistere)

## Contesto

L'MVP web è completo ma non esiste alcun modo di metterlo in produzione: nessun
Dockerfile, nessuna guida, nessuna decisione su dove giri.
`infra/docker/docker-compose.yml` **è e resta la fixture di sviluppo** (regtest
Lightning, Mailpit, MinIO opt-in): non è riusabile in produzione e non viene
toccata da questo ADR. Qui si decide come si costruisce, si porta su e si
mantiene un'istanza reale.

### Non requisiti (dichiarati)

Ciò che segue non è "non ancora": è escluso per scelta, e le decisioni sotto
ne dipendono.

- **Nessun nodo Lightning della piattaforma** (ADR-013). In produzione non
  esiste stack regtest: niente `bitcoind`, niente LND, niente Alby Hub. I
  wallet sono degli utenti e i pagamenti sono diretti tra loro; la piattaforma
  coordina preimage e non tocca fondi. Lo stack di produzione è
  Postgres + API + web + reverse proxy, punto.
- **Nessuna replica multipla dell'API.** I worker girano nel processo API
  (ADR-011) e le foto stanno su disco locale (ADR-020): una sola istanza è
  la topologia per cui il codice è scritto oggi.
- **Niente Kubernetes**, né Nomad, né service mesh: un'istanza sola non ha
  niente da orchestrare.
- **Niente migrazione a S3**: il default resta il driver `fs` (ADR-023 §5). Il
  driver S3 esiste per chi scala, che non è questo deploy.
- **Niente `FAKE_WALLETS`, niente seed demo.** Il seed popola dati finti; i
  fake wallet sono una rete Lightning in memoria.

## Decisioni

### 1. Due immagini multi-stage, contesto di build = radice del monorepo

`infra/production/api.Dockerfile` e `infra/production/web.Dockerfile`, en-
trambi da buildare dalla radice. Il contesto è l'intero monorepo **per
necessità, non per comodità**: i pacchetti `@mercurio/*` si risolvono tra loro
attraverso `main: ./dist/index.js`, quindi l'API non è costruibile da
`apps/api` da sola — `shared`, `core`, `db` ed `escrow` vanno compilati prima.

Struttura comune, in quest'ordine per ragioni di caching:

1. `COPY package.json pnpm-lock.yaml` + `pnpm fetch` — popola lo store dal
   solo lockfile: il layer lento si riusa a ogni modifica di codice.
   `package.json` serve unicamente al campo `packageManager`: senza, corepack
   sceglie il pnpm che si porta dietro invece di quello del lockfile (la prima
   build è fallita esattamente così).
2. `pnpm install --frozen-lockfile --offline`, poi build **filtrata**:
   `pnpm --filter "@mercurio/api..." build` compila l'API e i soli pacchetti da
   cui dipende, in ordine topologico. Il web non viene costruito nell'immagine
   dell'API e viceversa.
3. **API**: `pnpm deploy --filter=@mercurio/api --prod /app` risolve i link di
   workspace in un albero autoconsistente con le sole dipendenze di
   produzione — nessun sorgente, nessun toolchain, niente da potare a mano. Gira
   dopo la build (copia i pacchetti com'è il disco: le `dist/` devono già
   esserci) e si porta dietro `packages/db/drizzle/*.sql`, che serviranno alle
   migrazioni.
   **Web**: `output: 'standalone'` di Next, che traccia i file necessari e ne
   emette un albero radicato al monorepo (`outputFileTracingRoot`) — senza
   quest'ultimo la `dist` di `@mercurio/shared` resterebbe fuori dal bundle.
4. Runtime: `node:22-alpine`, utente non privilegiato `node`, `HEALTHCHECK` che
   usa la `fetch` globale di Node (nessun curl da installare).

`output: 'standalone'` è **opt-in** via `NEXT_STANDALONE=true` (impostata solo
nel Dockerfile): per assemblarlo Next materializza `node_modules` come
symlink, e un account Windows senza Developer Mode non può crearli — lasciarlo
sempre acceso romperebbe `pnpm build` su una macchina di sviluppo per produrre
un artefatto che usa solo l'immagine.

### 2. Precondizione scoperta: l'output di `tsc` non era eseguibile da Node

Il primo container dell'API è morto all'avvio:
`ERR_MODULE_NOT_FOUND: Cannot find module '/app/dist/app'`. Gli import
relativi erano senza estensione (`import { buildApp } from './app'`), forma
che l'ESM loader di Node rifiuta e che `moduleResolution: "Bundler"` permette
di scrivere ed emette invariata. Non se n'era mai accorto nessuno perché
**la `dist/` non era mai stata eseguita**: `pnpm dev` gira su tsx e i test su
vitest, e tutti e due risolvono l'estensione da soli.

Deciso di **aggiungere le estensioni esplicite** (357 specificatori su 117
file di `apps/api` e `packages/*`, riscritti da un codemod che risolve ogni
percorso contro il filesystem invece di indovinarlo: `./x` → `./x.js` se
esiste `x.ts`, → `./x/index.js` se esiste `x/index.ts`; verificato da
typecheck, dall'intera suite e dal container che parte).

Alternativa scartata: **impacchettare l'API con esbuild** solo per l'immagine.
Sarebbe stata contenuta nel path di deploy, ma lascia la `dist/` inservibile
per chiunque altro, fa girare in produzione un artefatto diverso da quello che
i test esercitano, e richiede comunque un plugin custom (`--packages=external`
tratta anche `@mercurio/*` come esterni). Le estensioni esplicite sistemano un
difetto vero: la `dist/` pubblicata è ora caricabile da Node — il che sblocca
anche lo scenario "worker separabili dal processo API" che l'ADR-011 dà per
possibile senza cambi di codice.

### 3. Topologia: compose di produzione su un singolo VPS

| Opzione                                       | Pro                                                                                        | Contro                                                                                                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Compose su un VPS** _(scelta)_           | Le foto stanno su un disco vero; tutto riproducibile in locale; nessun vendor; costo di un VPS | L'host è un single point of failure; aggiornamenti e backup sono responsabilità di chi gestisce                                                                |
| B. PaaS (Fly.io, Railway, Render) + PG gestito | Zero manutenzione dell'host, TLS incluso                                                   | Il filesystem è effimero: il driver `fs` perderebbe le foto a ogni deploy, obbligando a S3 (ADR-023) che è dichiarato fuori scope; lock-in; niente riproducibilità |
| C. Kubernetes / Nomad                         | Scala e rolling update                                                                     | Un'orchestrazione per una replica sola: costo fisso di complessità senza contropartita — non requisito                                                          |

Scelta **A**. La ragione decisiva è che il driver foto di default vuole un
disco persistente (ADR-020): su un PaaS effimero l'MVP non funziona senza
prima adottare S3, cioè senza fare una migrazione che questo lavoro dichiara
fuori scope. Il resto segue: un solo servizio stateful (ADR-011), una sola
replica per costruzione, progetto open source che chiunque deve poter
autoospitare, e `COORDINATOR_KEY` che deve restare identica tra i riavvii —
proprietà più facile da garantire su un host che si controlla.

Postgres gira nel compose, sullo stesso host, con un volume nominato. Passare
a un Postgres gestito resta una modifica di una riga (le credenziali in
`.env`, da cui il compose compone `DATABASE_URL`) se un domani lo si vorrà.

### 4. Reverse proxy e TLS: Caddy, unica origin pubblica

Caddy ottiene e rinnova i certificati da solo, con una direttiva per sito e
senza cron di rinnovo: `nginx + certbot` vorrebbe tre pezzi (server, client
ACME, timer di reload) e Traefik una macchina a label per un'unica rotta
statica. Caddy è l'unico servizio che pubblica porte (80/443); Postgres, API e
web parlano sulla rete di compose e **non sono raggiungibili dall'esterno**.

### 5. Same-origin: il contratto dell'ADR-018 è del proxy, non più della rewrite

L'ADR-018 decide che il browser parli con l'API **sulla stessa origin**, così
che il cookie di sessione httpOnly viaggi senza attributi cross-site e l'API
non debba aprire CORS. In produzione quel contratto lo serve Caddy:

```
handle_path /api/*  →  reverse_proxy api:3001    # /api/health → api:3001/health
handle              →  reverse_proxy web:3000
```

Identico, come contratto, alla rewrite `/api/:path*` → `${API_URL}/:path*` che
`next.config.mjs` continua a fornire in sviluppo: **una sola origin, zero
CORS, cookie invariato**. Cambia il meccanismo, non la decisione.

Perché non far passare anche in produzione ogni chiamata dalla rewrite di
Next:

- **Le rewrite sono congelate a build time.** Verificato: `next build` serializza
  la destinazione dentro `routes-manifest.json` e `required-server-files.json`.
  Passare `API_URL` come build arg incastrerebbe l'indirizzo di UN deployment
  dentro l'immagine, e un valore sbagliato romperebbe in silenzio ogni
  chiamata del browser. L'immagine del web non contiene nessun indirizzo.
- **L'API pubblica (ADR-002) non deve dipendere dal web.** Con la rewrite in
  mezzo, un client terzo — e domani l'app mobile — passerebbe dal processo
  Next per parlare con l'API; se il web si riavvia, l'API tace. Con la rotta
  al proxy l'API resta raggiungibile: l'OpenAPI è servita su
  `https://<dominio>/api/docs`.

Le pagine server-rendered (lista hub, stato pubblico da QR) leggono `API_URL`
**a runtime** (verificato: `process.env.API_URL` sopravvive nei chunk server) e
nel compose vale `http://api:3001`. I browser non la usano mai.

### 6. Segreti: solo ambiente, mai nel repo

Un file `.env` accanto al compose (`chmod 600`, già coperto da `.gitignore`),
con `infra/production/.env.example` a fare da riferimento con soli
**placeholder**. Il compose lo passa all'API con `env_file`. Nessun segreto
finisce in un'immagine: `.dockerignore` esclude `**/.env*` e — non meno
importante — `infra/docker/volumes`, dove vivono i macaroon e i wallet del
regtest di sviluppo.

`DATABASE_URL` non sta in `.env`: il compose la **compone** dalle credenziali
Postgres, per non tenerne due copie che possono divergere. Conseguenza da
documentare: la password finisce in una URL, quindi deve essere URL-safe
(`openssl rand -hex 32` lo è sempre).

**`COORDINATOR_KEY` è la variabile critica**: cifra le preimage e i segreti dei
wallet degli utenti (ADR-013). Deve restare **identica tra i riavvii** e va
messa nei backup: cambiarla o perderla significa che i wallet sigillati non si
riaprono più — le hold pendenti non sono più rilasciabili e si risolvono
scadendo a favore dei pagatori. Non è ruotabile in place.

### 7. Migrazioni: servizio one-shot che l'API aspetta

Un servizio `migrate` che usa la **stessa immagine** dell'API con un comando
diverso (`node node_modules/@mercurio/db/dist/migrate.js`), e l'API che parte
solo dopo il suo `service_completed_successfully`. Così una migrazione fallita
blocca il deploy in modo visibile invece di lasciare un'API in crash-loop
contro uno schema che non capisce. Le migrazioni sono idempotenti (Drizzle
tiene la sua tabella) e con **una sola replica** non esiste corsa tra
migrazioni concorrenti — è la topologia §3 a rendere superflua qualunque lock.

Il **seed è solo demo**: nel compose non esiste alcun servizio che lo esegua.
Il binario però è nell'immagine (`dist/seed.js` viene compilato come il resto):
non è impossibile lanciarlo, è solo cosa che nessuno deve fare — detto qui e
nella guida invece di fingere una garanzia strutturale che non c'è.

### 8. `TRUST_PROXY`: i limiti anti-abuso dietro il proxy

Due fatti trovati mentre si preparava questo deploy:

1. **I rate limit non erano attivi affatto.** `@fastify/rate-limit` era
   registrato senza `await`: aggancia i limiti per rotta con un hook `onRoute`,
   che così veniva attaccato dopo la definizione delle rotte. Ogni limite di
   RISKS §7 — globale e per rotta — era inerte pur risultando configurato
   (l'unico controllo vivo era la soglia per email a database in `lib/auth.ts`).
   Corretto; `apps/api/src/rate-limit.test.ts` è la regressione.
2. **Dietro un proxy ogni richiesta arriva dall'indirizzo del proxy**, quindi
   il limiter — che indicizza su `request.ip` — metterebbe l'intera internet in
   un solo bucket: il quinto login della giornata bloccherebbe tutti gli altri.

Perciò `TRUST_PROXY` (default **off**): quando è `true` Fastify legge
`X-Forwarded-For` come indirizzo del client. È off di default perché fidarsi di
quell'header **senza nessuno davanti che lo riscriva** permette a chiunque di
falsificare il proprio indirizzo e prendersi una quota nuova a ogni richiesta:
lo stesso controllo, fallito aperto. Nel compose è `true` perché Caddy è
l'unica via d'ingresso **e sovrascrive l'header**: verificato empiricamente —
105 richieste ciascuna con un `X-Forwarded-For` diverso e inventato hanno
prodotto 100 `200` e 5 `429`, cioè sono finite tutte nello stesso bucket, quello
del client vero. La sicurezza dei limiti per IP sta in questa coppia: esporre
l'API direttamente con `TRUST_PROXY=true` sarebbe un bypass.

### 9. SMTP di produzione

Il mailer parlava solo con Mailpit: nessuna autenticazione e un mittente
`@mercurio.local` fisso. Nessun relay reale accetta l'uno o l'altro. Aggiunte
`SMTP_USER`/`SMTP_PASS` (auth, obbligatorie insieme: metà configurazione
fallisce alla prima email, non all'avvio), `SMTP_SECURE` (TLS implicito,
dedotto dalla porta: 465 sì, 587 parte in chiaro e sale con STARTTLS) e
`SMTP_FROM` (che deve essere un dominio proprio, o SPF/DKIM non allineano e le
email diventano spam). I default restano quelli di Mailpit: **in sviluppo non
si configura nulla**. L'outbox (ARCHITECTURE §4) resta la fonte di verità: un
relay irraggiungibile ritarda le email, non perde eventi.

### 10. Backup: le quattro cose che contano

Postgres (`pg_dump`), il volume delle foto, **`COORDINATOR_KEY`** e i
certificati di Caddy. Le prime due sono lo stato, la terza è ciò che rende lo
stato leggibile: un dump ripristinato senza la chiave dà wallet che non si
aprono. `infra/production/backup.sh` fa le prime due in un colpo, la terza sta
nel `.env` (da custodire fuori dall'host). Procedura di restore in
`docs/DEPLOY.md`.

### 11. Log e monitoraggio minimo

Il driver `json-file` di Docker tiene i log per sempre e riempie in silenzio il
disco di un VPS piccolo: capped a `10m × 5` per servizio. I log applicativi
sono quelli di pino su stdout (`docker compose logs`). `/health` è una sonda di
**liveness**, non di readiness: risponde dal livello HTTP senza toccare
Postgres, apposta — un singhiozzo del database non deve far ammazzare
un'API che sta benissimo. `restart: unless-stopped` ovunque, e i `depends_on`
condizionali fanno il resto. Un check di uptime esterno è un todo umano: da
qui dentro non si controlla la propria stessa morte.

## Conseguenze

- Esiste un percorso di deploy riproducibile: `docker compose -f
  infra/production/docker-compose.yml up -d --build` + un `.env`. Verificato in
  locale con env fittizie — `/api/health` 200, home servita, `/hubs`
  server-rendered che legge davvero dall'API (spegnendo l'API la stessa pagina
  passa allo stato d'errore), scrittura reale end-to-end fino a Postgres.
- La `dist/` del backend è finalmente eseguibile da Node: la convenzione
  "estensioni esplicite negli import relativi" vale ora per `apps/api` e
  `packages/*` e va mantenuta nel codice nuovo (`apps/web` non è toccata: la
  compila Next).
- I limiti anti-abuso di RISKS §7 sono attivi per la prima volta. Chi girava
  senza proxy non se ne accorge; chi mette un proxy davanti **deve** impostare
  `TRUST_PROXY=true`, altrimenti il primo abuso blocca tutti.
- La superficie dei segreti cresce di `SMTP_PASS` accanto a `COORDINATOR_KEY` e
  alle credenziali Postgres: tutte solo in `.env`, mai nel repo.
- `infra/docker/docker-compose.yml` resta intatta e resta di sviluppo. Ora ci
  sono due compose e la differenza va tenuta chiara: quella di sviluppo ha
  nodi Lightning e un SMTP finto, questa non li ha e non deve averli.
- Il deploy è manuale (`git pull` + `up -d --build` sull'host). La CI
  costruisce entrambe le immagini a ogni push su `main` per accorgersi subito
  se un Dockerfile si rompe, ma **non pubblica e non deploya**: senza un
  registry e un host reali sarebbe cerimonia senza destinatario. Quando ci
  saranno, il passo mancante è una `docker push` e un `compose pull`.
