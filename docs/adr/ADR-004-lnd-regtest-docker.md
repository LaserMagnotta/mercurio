# ADR-004 — Lightning di sviluppo: bitcoind regtest + LND via Docker Compose

- Stato: accettato — 2026-07-12 (CI GitHub Actions implementata il 2026-07-16,
  vedi "Implementazione CI" sotto)

## Contesto

Tutta la logica di denaro va testata senza fondi reali, in modo riproducibile e in CI.
Con l'architettura zero-custodia (ADR-013) la piattaforma non ha un nodo proprio:
servono i **wallet degli utenti** — nodi Lightning di test per mittente, vettore e
hub — su cui esercitare hold invoice, rivelazioni di preimage e annullamenti.

## Decisione

`infra/docker/docker-compose.yml` con: `bitcoind` in **regtest**, **LND** ×3 come
wallet utente (`lnd-alice` mittente, `lnd-bob` vettore, `lnd-carol` hub), più
`postgres` e `mailpit`. Script di bootstrap idempotente: mina i blocchi iniziali,
finanzia i wallet, apre i canali alice↔bob↔carol. In dev i wallet sono collegati
tramite l'adapter `lnd_rest` di `WalletConnection` (la stessa interfaccia
dell'adapter NWC di produzione). I test di integrazione girano contro questo
ambiente anche in CI (GitHub Actions con i servizi Docker).

Implementazione LND (e non altre) perché le **hold invoice** (`invoicesrpc`) — il
cuore del meccanismo ADR-013 — sono una sua funzione matura e ben documentata, e
l'ecosistema di tooling è il più ampio.

## Alternative considerate

- **Polar**: perfetto per esplorare a mano, ma è un'app GUI: non gira in CI. Resta
  consigliato come strumento personale di sviluppo, non è l'ambiente di riferimento.
- **Core Lightning / Eclair**: valide (CLN ha `holdinvoice` via plugin), ma tooling
  meno battuto per il nostro caso; nessun vantaggio che giustifichi la strada meno
  percorsa. Restano compatibili lato utente: basta un adapter `WalletConnection`.
- **Testnet/signet invece di regtest**: lenti (blocchi veri), faucet, flakiness in CI.
  Regtest è deterministico; signet utile più avanti come staging pre-mainnet.
- **Mock del layer Lightning nei test**: c'è comunque (adapter `fake` di
  `WalletConnection` per i test unitari di core), ma i test _di integrazione_
  devono attraversare hold invoice vere.

## Implementazione CI (2026-07-16)

La promessa "i test di integrazione girano contro questo ambiente anche in
CI" era rimasta sulla carta: nessun workflow esisteva. `.github/workflows/ci.yml`
la chiude con due job indipendenti, entrambi su `ubuntu-latest` (Docker già
presente sul runner):

- **`test`**: `pnpm install --frozen-lockfile`, poi `lint` → `typecheck` →
  `build` → `test` (unit, su `pglite` in-memory — nessun servizio Docker
  richiesto).
- **`integration`**: `pnpm build` (i pacchetti workspace si risolvono a
  vicenda via `dist/`, non via sorgente); crea come utente `runner` le
  directory dei bind-mount sotto `infra/docker/volumes/` citate nel compose
  (perché, sotto); `docker compose -f infra/docker/docker-compose.yml up -d`;
  `bash infra/docker/bootstrap.sh` (non `./bootstrap.sh`: lo script non è
  tracciato come eseguibile in git); rende leggibili i contenuti dei
  bind-mount (di nuovo, perché sotto); infine `pnpm test:integration`. Log dei
  servizi raccolti solo in caso di fallimento; `docker compose down -v`
  sempre in coda, successo o meno.

Entrambi i job girano su push/PR verso `main`. Nessuna delle "credenziali" di
questo stack (password hub `mercurio-regtest`, `rpcuser`/`rpcpassword` di
bitcoind) è diventata un secret GitHub: sono fixture regtest committate, come
da CLAUDE.md — non custodiscono nulla di reale.

### Permessi sui bind-mount: un problema di Linux, non di Windows

La prima stesura di questa sezione dava per scontato che l'`ubuntu-latest` del
runner non avesse "niente dei problemi di permessi sui bind-mount che esistono
solo su Windows". È il contrario, e il primo run reale lo ha dimostrato subito
(mai visto in locale — perché, in fondo a questa sezione):

1. **`infra/docker/volumes/` non esiste su un checkout pulito** (è
   gitignorata: contiene solo dati runtime). Lasciata fare a Docker, la
   directory sorgente di ogni bind-mount viene creata da `docker compose up`
   come root, perché il daemon gira come root. `bootstrap.sh`, che gira come
   utente `runner`, non riusciva più a scrivere dentro
   `infra/docker/volumes/`: il suo stesso `mkdir -p volumes/nwc` falliva con
   `Permission denied`. **Fix**: un passo che crea con `mkdir -p` tutte le
   directory citate nel compose, eseguito da `runner` PRIMA di `docker
   compose up` — così è `runner` il proprietario fin dall'inizio, e Docker
   non ha nulla da creare.
2. **Risolto il punto 1, un secondo problema resta**: sia
   `polarlightning/lnd` sia `ghcr.io/getalby/hub` girano come root nel
   container (nessun `USER` in nessuna delle due immagini), quindi
   `admin.macaroon` e tutto il resto sotto `.lnd` vengono scritti root:root,
   modalità 0600 (default di LND). La suite di integrazione legge il
   macaroon direttamente da disco come utente `runner`
   (`packages/escrow/src/testing/regtest.ts`, non passa dal container): con
   quei permessi, `EACCES`. **Fix**: `sudo chmod -R go+rX infra/docker/volumes`
   dopo `bootstrap.sh` e prima di `pnpm test:integration` (`sudo` è
   passwordless sui runner ospitati da GitHub).

Nessuno dei due problemi si manifesta in locale su Docker Desktop per
Windows: il suo filesystem condiviso non applica gli stessi controlli POSIX
su UID/GID/modalità che un bind-mount nativo Linux applica sul runner
(comportamento noto della sua traduzione host↔container, a prescindere dal
backend Hyper-V o WSL2) — è quello, non l'assenza del problema, il motivo per
cui lo sviluppo locale non lo aveva mai mostrato.

## Conseguenze

- Chi clona il repo ha una rete Lightning funzionante con `docker compose up` + script.
- CI più lenta ma onesta: i bug di pagamento emergono prima del mainnet.
- Il passaggio a produzione cambia solo configurazione (mainnet, macaroon, TLS),
  non codice.
