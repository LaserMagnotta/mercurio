# Mercurio — guida al deploy di produzione

> Le decisioni dietro a ogni scelta di questa guida — e le alternative
> scartate — sono in [ADR-024](adr/ADR-024-production-deploy.md).
> Per lo sviluppo locale vale il [README](../README.md): `infra/docker/` è la
> fixture di sviluppo (regtest Lightning, Mailpit) e **non** si usa qui.

## 1. Cosa gira in produzione

Quattro container su un solo host, definiti da
[`infra/production/docker-compose.yml`](../infra/production/docker-compose.yml):

| Servizio   | Ruolo                                                                      | Porte pubbliche |
| ---------- | -------------------------------------------------------------------------- | --------------- |
| `caddy`    | Unica origin pubblica: TLS automatico, `/api/*` → API, tutto il resto → web | 80, 443         |
| `web`      | Next.js (`apps/web`)                                                       | nessuna         |
| `api`      | Fastify + worker pg-boss nello stesso processo (ADR-011)                   | nessuna         |
| `postgres` | Dati applicativi, ledger ombra e code                                      | nessuna         |

Più un servizio `migrate`, one-shot: applica le migrazioni e esce; l'API parte
solo se è uscito con successo.

**Cosa NON gira, per scelta** (ADR-024): nessun nodo Lightning della
piattaforma — non esiste `bitcoind`, non esiste LND, la piattaforma non ha un
wallet e non tocca mai fondi (ADR-013); nessuna replica multipla dell'API;
nessun Kubernetes; nessun dato demo.

## 2. Prerequisiti

- Un host Linux con **Docker Engine** e il plugin **compose v2**
  (`docker compose version`). 2 vCPU / 2 GB di RAM sono abbondanti per l'MVP.
- Un **dominio** con record A (e AAAA se hai IPv6) che punta all'host: Caddy
  ottiene il certificato con la sfida HTTP.
- **Porte 80 e 443 aperte** dall'esterno. La 80 non è opzionale: serve al
  rinnovo ACME, oltre che al redirect verso HTTPS.
- Un **relay SMTP** con credenziali (le email sono l'unico modo in cui un
  utente entra e riceve gli avvisi del ciclo di vita).
- Nessun Node, nessun pnpm, nessun Postgres installati sull'host: le immagini
  si costruiscono da sole.

## 3. Variabili d'ambiente

Vivono **solo** in `infra/production/.env` (permessi `600`, mai nel repo).
Il modello con i placeholder è
[`infra/production/.env.example`](../infra/production/.env.example).

### Da impostare

| Variabile           | Obbl.                | Default          | Contenuto                                                                              |
| ------------------- | -------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `MERCURIO_DOMAIN`   | sì                   | —                | Dominio servito da Caddy (`mercurio.example`). `http://localhost` = HTTP puro, no ACME |
| `WEB_URL`           | sì                   | `localhost:3000` | Base URL dei link dentro le email. Stessa origin, con lo schema                        |
| `POSTGRES_USER`     | sì                   | —                | Utente del database                                                                    |
| `POSTGRES_PASSWORD` | sì                   | —                | **URL-safe** (finisce dentro `DATABASE_URL`): `openssl rand -hex 32` va sempre bene    |
| `POSTGRES_DB`       | sì                   | —                | Nome del database                                                                      |
| `COORDINATOR_KEY`   | sì                   | —                | 32 byte hex, `openssl rand -hex 32`. **Vedi §4: stabile e da backuppare**              |
| `SMTP_HOST`         | sì                   | `localhost`      | Host del relay                                                                         |
| `SMTP_PORT`         | no                   | `1025`           | `587` (STARTTLS) o `465` (TLS implicito)                                               |
| `SMTP_USER`         | insieme a `SMTP_PASS` | —               | Utenza del relay                                                                       |
| `SMTP_PASS`         | insieme a `SMTP_USER` | —               | Password del relay                                                                     |
| `SMTP_FROM`         | sì                   | `…@mercurio.local` | Mittente: un dominio tuo, o SPF/DKIM non allineano e le email finiscono in spam     |
| `SMTP_SECURE`       | no                   | dedotto          | TLS implicito; dedotto dalla porta (`465` → `true`). Serve solo per relay anomali      |
| `EUR_RATE_PROVIDER` | **sì** (in produzione) | `fixed`        | `market` = mediana di ticker pubblici reali; `fixed` = tasso fissato a mano. Vedi sotto |
| `EUR_RATE_SOURCES`  | no                   | tutte e tre      | Ticker da usare per `market`: `kraken`, `bitstamp`, `coinbase`. Almeno due             |
| `EUR_RATE_SATS_PER_EUR` | solo con `fixed` | `1600` (non in produzione) | Sats per euro fissati a mano. In produzione con `fixed` è obbligatoria       |

Le variabili `PHOTO_STORAGE_*` servono solo per passare al driver S3
(ADR-023): il default `fs` è quello giusto per questo deploy e non richiede
configurazione.

### Il cambio EUR→sats: perché l'API si rifiuta di partire senza (ADR-025)

Quel numero fa due cose serie: dimensiona il **tetto ToS del bond** (1000 €) e
viene **congelato su ogni spedizione per tutta la sua vita** (ADR-008) — se è
sbagliato, resta sbagliato lì dentro fino alla consegna, e niente sembra rotto.
Perciò in produzione **nessun cambio può venire da un default**: senza
`EUR_RATE_PROVIDER` l'API non parte, e il messaggio dice cosa scegliere.

- **`EUR_RATE_PROVIDER=market`** — la scelta giusta. L'API interroga tre ticker
  BTC/EUR pubblici (Kraken, Bitstamp, Coinbase) e ne prende la **mediana**, così
  una fonte rotta è l'outlier e viene scartata. Nessuna chiave, nessun account,
  nessun dato utente verso terzi: sono tre GET fatte dal server. Il valore è in
  cache 5 minuti. L'unico requisito nuovo è che **l'host possa uscire in HTTPS**
  verso quei tre domini.
- **`EUR_RATE_PROVIDER=fixed`** + `EUR_RATE_SATS_PER_EUR` — la via d'uscita se
  un giorno tutte e tre le fonti cambiassero formato insieme: si fissa un numero
  a mano, consapevolmente, e si continua a spedire. Con `fixed` la variabile del
  tasso è obbligatoria: il default (1600 sats/€) è la scala dell'esempio della
  documentazione, non un prezzo.

Se il feed è irraggiungibile, la creazione di spedizioni continua a usare
l'ultimo cambio noto **fino a 6 ore**; oltre risponde `503
eur_rate_unavailable` finché le fonti non tornano. **Nessun altro flusso si
ferma**: consegne, ritiri, rilasci e rimborsi leggono il cambio congelato sulla
spedizione, non il feed.

### Impostate dal compose (non metterle in `.env`)

`DATABASE_URL` (composta dalle credenziali Postgres, per non averne due copie
che divergono), `NODE_ENV=production`, `PORT=3001`, `TRUST_PROXY=true` (i
limiti anti-abuso devono vedere l'IP vero del client, non quello di Caddy) e
`API_URL=http://api:3001` per il web.

### Da non impostare mai

| Variabile           | Perché                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `FAKE_WALLETS`      | Rete Lightning finta in memoria: l'API **rifiuta di avviarsi** se è `true` con `NODE_ENV=production`         |
| `RUN_WORKERS=false` | Spegne i worker in-process: con una replica sola, timer di giacenza, email e riconciliazione non partirebbero |

E il seed (`db:seed`) è **solo demo**: nel compose non c'è nulla che lo esegua,
e non va eseguito a mano.

## 4. `COORDINATOR_KEY`: leggere prima di generarla

`COORDINATOR_KEY` cifra le preimage dei pagamenti e i segreti dei wallet degli
utenti (ADR-013). Tre conseguenze pratiche:

- **Deve restare identica tra i riavvii.** Se cambia, i wallet sigillati non si
  riaprono: le hold pendenti non sono più rilasciabili e si risolvono
  scadendo a favore di chi ha pagato.
- **Non è ruotabile in place.** Non esiste una migrazione che ricifri.
- **Va nel backup, fuori da questo host.** Un dump del database ripristinato
  senza la sua chiave è illeggibile per la parte che conta.

Generala una volta, sull'host, e conservala dove conservi i segreti:

```sh
openssl rand -hex 32
```

## 5. Primo deploy

```sh
# 1. Il codice sull'host
git clone https://github.com/<owner>/mercurio.git /srv/mercurio
cd /srv/mercurio

# 2. L'ambiente
cp infra/production/.env.example infra/production/.env
chmod 600 infra/production/.env
openssl rand -hex 32      # → COORDINATOR_KEY
openssl rand -hex 32      # → POSTGRES_PASSWORD
${EDITOR:-nano} infra/production/.env

# 3. Su (la prima build richiede qualche minuto)
docker compose -f infra/production/docker-compose.yml up -d --build
```

Verifica:

```sh
docker compose -f infra/production/docker-compose.yml ps
# postgres/api "healthy", migrate "exited (0)", web e caddy "running"

curl -fsS https://<dominio>/api/health     # {"status":"ok"}
curl -fsS -o /dev/null -w '%{http_code}\n' https://<dominio>/    # 200
```

L'API pubblica e la sua OpenAPI (ADR-002) stanno sulla stessa origin del web:
`https://<dominio>/api/...`, documentazione su `https://<dominio>/api/docs`.

Il primo account si crea da solo: dal browser, `Accedi` → arriva il magic link
via email (primo accesso = registrazione).

### Se qualcosa non parte

```sh
docker compose -f infra/production/docker-compose.yml logs migrate   # migrazioni
docker compose -f infra/production/docker-compose.yml logs api       # avvio API
docker compose -f infra/production/docker-compose.yml logs caddy     # TLS/ACME
```

Sintomi tipici: **il certificato non arriva** → il DNS non punta ancora qui, o
la 80 è chiusa; **`migrate` esce != 0** → l'API non parte apposta (è il
comportamento voluto: leggi il log e correggi, non aggirare); **`api` unhealthy
al primo avvio** → quasi sempre `COORDINATOR_KEY` assente o non di 64 caratteri
hex, oppure `EUR_RATE_PROVIDER` non impostata (§3: in produzione va scelta, non
ereditata da un default). In tutti e due i casi l'API scrive nel log esattamente
cosa manca e cosa metterci.

## 6. Aggiornamento

```sh
cd /srv/mercurio
git pull
docker compose -f infra/production/docker-compose.yml up -d --build
```

Le migrazioni girano da sole prima dell'API (sono idempotenti). C'è una
**breve interruzione** mentre i container si ricreano: con una replica sola non
esiste rolling update, ed è una conseguenza accettata della topologia
(ADR-024 §3), non una svista.

Per tornare indietro:

```sh
git checkout <sha-precedente>
docker compose -f infra/production/docker-compose.yml up -d --build
```

Attenzione: **le migrazioni non tornano indietro da sole**. Se la versione che
stai abbandonando ne ha applicata una distruttiva, il rollback del codice non
basta — serve il ripristino del §7.

## 7. Backup e ripristino

### Cosa salvare

1. **Postgres** — dati, ledger, code.
2. **Il volume delle foto** — i blob (ADR-020).
3. **`COORDINATOR_KEY`** — senza, i primi due non bastano (§4).
4. _(Facoltativo)_ il volume `caddy-data`: certificati e account ACME. Senza,
   Caddy li richiede di nuovo — gratis, ma dentro i rate limit di Let's Encrypt.

### Backup

[`infra/production/backup.sh`](../infra/production/backup.sh) fa 1 e 2:

```sh
cd /srv/mercurio
./infra/production/backup.sh /var/backups/mercurio
```

Ogni notte, da cron:

```
0 3 * * * cd /srv/mercurio && ./infra/production/backup.sh /var/backups/mercurio >> /var/log/mercurio-backup.log 2>&1
```

Lo script fallisce se un file esce vuoto. Copia i backup **fuori dall'host**:
un backup sullo stesso disco protegge da un `dropdb`, non da un incendio.

### Ripristino

```sh
cd /srv/mercurio
C="docker compose -f infra/production/docker-compose.yml"

# 1. Ferma chi scrive (Postgres resta su)
$C stop web api

# 2. Database: ricrea e ripristina
$C exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
$C exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner' \
  < /var/backups/mercurio/postgres-<stamp>.dump

# 3. Foto (un container temporaneo che monta il volume)
$C run --rm --no-deps -T api sh -c 'tar -xzf - -C /var/lib/mercurio/photos' \
  < /var/backups/mercurio/photos-<stamp>.tar.gz

# 4. Rimetti su
$C up -d
```

Prima del punto 4, assicurati che `COORDINATOR_KEY` in `.env` sia **quella di
quando il dump è stato fatto**. Con una chiave diversa il sistema riparte e
sembra sano, ma nessun wallet salvato si riapre.

## 8. Log e diagnostica

```sh
C="docker compose -f infra/production/docker-compose.yml"
$C logs -f api            # log applicativi (pino)
$C ps                     # stato e healthcheck
$C exec -T postgres psql -U mercurio -d mercurio -c '\dt'
```

I log sono limitati a 10 MB × 5 file per servizio (altrimenti riempiono il
disco in silenzio). `/health` è una sonda di **liveness**: dice che il processo
risponde, non che Postgres stia bene — è voluto (ADR-024 §11).

**Todo umano**: un check di uptime esterno che interroghi
`https://<dominio>/api/health`. Un host non si accorge della propria morte.

## 9. Limiti noti di questa topologia

- **Un host solo**: se muore, il servizio è giù finché non lo ricostruisci dai
  backup. Accettato: l'MVP non promette continuità di servizio.
- **Interruzione a ogni aggiornamento**, di qualche secondo (§6).
- **Le foto stanno su disco locale**: sono nel backup, non in replica. Per
  scalare oltre una replica esiste il driver S3 (ADR-023), che è un'altra
  decisione da prendere, non un flag da accendere di corsa.
- **Il deploy è manuale.** La CI costruisce le immagini a ogni push per
  accorgersi subito se un Dockerfile si rompe, ma non pubblica né deploya:
  non c'è nessun registry né host reale a cui parlare (ADR-024 §Conseguenze).
