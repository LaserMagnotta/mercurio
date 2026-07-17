# ADR-023 — Driver S3-compatibile per il blob storage delle foto (MinIO/Garage), selezione da config

- Stato: accettato e implementato — 2026-07-17
- Contesto: ADR-020 (interfaccia `BlobStore`, driver fs content-addressed —
  §1 rimandava il driver S3 a questo ADR), ADR-011 (un solo servizio stateful
  nell'MVP, Postgres)

## Contesto

ADR-020 ha introdotto `BlobStore` (`put`/`get`/`delete`/`list`) proprio perché
il driver filesystem dell'MVP potesse essere sostituito senza toccare rotte o
worker: "un servizio stateful in più per l'MVP... rimandato a un ADR futuro".
Quel futuro è ora: più repliche di `apps/api` dietro un load balancer non
possono condividere `./data/photos` su disco locale, e la promessa dell'ADR-020
era esattamente di non dover riscrivere nulla per risolverlo.

Questo ADR **aggiunge** un secondo driver, non sostituisce il primo: il
default resta il filesystem (nessun cambiamento per chi non scala oltre una
replica), lo storage S3-compatibile è un opt-in di configurazione.

## Decisioni

### 1. `createS3BlobStore`: stessa interfaccia, `@aws-sdk/client-s3`

Il driver implementa `BlobStore` con l'SDK ufficiale AWS per S3, che parla
l'API S3 implementata sia da MinIO sia da Garage (e da S3 vero): un solo
client, un solo codice, nessuna dipendenza specifica del vendor. Il client è
configurato con `forcePathStyle` (default `true`): MinIO e Garage richiedono
l'indirizzamento path-style (`endpoint/bucket/key`); il virtual-hosted style
(`bucket.endpoint/key`) resta disponibile per S3 reale impostando il flag a
`false` da config.

Le rotte (`routes/photos.ts`) e il worker di purge (`shipments/photo-purge.ts`)
non cambiano: dipendono solo dall'interfaccia, esattamente come previsto
dall'ADR-020.

### 2. Configurazione da env, mai segreti nel repo

`PHOTO_STORAGE_DRIVER` seleziona il driver: `fs` (default, invariato) o `s3`.
Quando è `s3`, questi env determinano il driver (nessun default per le
credenziali — mancanti ⇒ errore esplicito all'avvio, non un fallback silenzioso):

| Variabile                              | Contenuto                                          |
| --------------------------------------- | --------------------------------------------------- |
| `PHOTO_STORAGE_S3_ENDPOINT`             | URL del servizio S3-compatibile (es. `http://localhost:9000`) |
| `PHOTO_STORAGE_S3_BUCKET`               | Bucket dedicato ai blob delle foto                  |
| `PHOTO_STORAGE_S3_REGION`               | Default `us-east-1` (valore convenzionale per MinIO/Garage, che non instradano per regione) |
| `PHOTO_STORAGE_S3_ACCESS_KEY_ID`        | Credenziale — mai nel repo                          |
| `PHOTO_STORAGE_S3_SECRET_ACCESS_KEY`    | Credenziale — mai nel repo                          |
| `PHOTO_STORAGE_S3_FORCE_PATH_STYLE`     | Default `true`; `false` per S3 reale virtual-hosted |

Stesso pattern di `COORDINATOR_KEY`: le credenziali vivono solo nell'ambiente
di esecuzione.

### 3. Chiave oggetto = sha256, nessun fan-out a due livelli

Il driver fs usa `<sha[0..2]>/<sha>` per non affollare una singola directory
(limite del filesystem). Gli object store non hanno quel problema a volumi
MVP: la chiave S3 è lo sha256 stesso. `put` resta idempotente per costruzione
(stessa chiave ⇒ stessi byte); non serve la danza tmp-file + rename del
driver fs perché una `PutObject` è già atomica a livello di singolo oggetto —
un `get` concorrente non osserva mai byte parziali.

### 4. Refcount, purge, orphan sweep: invariati (ADR-020 §5)

`photo-purge.ts` passa attraverso `get`/`put`/`delete`/`list` e non conosce il
driver sotto: nessuna modifica. `list()` mappa `Contents[].LastModified` di
`ListObjectsV2` sul campo `modifiedAt` che lo sweep degli orfani già usa,
paginando su `ContinuationToken` (a volumi MVP è un singolo giro, come nel
driver fs).

### 5. MinIO nel docker-compose di sviluppo, solo per testare il driver S3

Il default resta il filesystem: nessuno stack aggiuntivo per lo sviluppo
quotidiano (ADR-020 §1 continua a valere). Il servizio `minio` compare nel
`docker-compose.yml` come componente **opt-in**, spento per chiunque non stia
lavorando su questo driver — si porta su con lo stesso file, puntando poi
`PHOTO_STORAGE_DRIVER=s3` e gli env `PHOTO_STORAGE_S3_*` all'istanza locale.

### 6. Test: stesso rigore del driver fs, più l'integrazione reale

Il contratto dell'interfaccia (`put`/`get`/`delete`/`list`, idempotenza,
`get` di chiave assente ⇒ `null`) è estratto in una suite condivisa eseguita
contro il driver memoria, il driver fs (directory temporanea) e il driver S3
— stesse asserzioni, tre driver. Il driver S3 richiede MinIO reale: la suite
che lo esercita segue il pattern regtest dell'ADR-004 (suite
`*.integration.test.ts`, proprio `test:integration` di `apps/api`, gated
dietro un servizio già in piedi) — inclusa nel job CI "integration" già
esistente, che porta su l'intero `docker-compose.yml` (MinIO compreso, nessun
servizio CI in più da orchestrare). I test di authz e purge già scritti per
ADR-020 restano quelli che girano nella suite ordinaria (`pnpm test`) contro
il driver memoria/fs — sono behavior delle rotte e del worker, non del driver:
non vanno duplicati per S3.

## Alternative considerate

- **Filesystem su rete (NFS/EFS) invece di S3**: nessun confine di interfaccia
  pulito da testare, gestione del mount fuori dal codice applicativo, e più
  difficile da riprodurre in CI. Scartato.
- **Client specifico MinIO (`minio-js`)**: funziona solo con MinIO, non con
  Garage né con S3 reale. `@aws-sdk/client-s3` parla l'API comune ai tre.
  Scartato.
- **Path-style sempre disattivo**: rompe MinIO/Garage, che lo richiedono.
  Tenuto configurabile ma con default `true` proprio per quei due target.
- **MinIO sempre acceso nel compose di sviluppo**: contraddirebbe ADR-020 §1
  ("niente container per il caso comune") per chi non tocca mai questo
  driver. Tenuto opt-in.

## Conseguenze

- Più repliche di `apps/api` possono condividere lo storage delle foto
  impostando `PHOTO_STORAGE_DRIVER=s3` — la sostituzione promessa
  dall'ADR-020 non tocca rotte né worker.
- Scegliere il driver S3 introduce un secondo servizio stateful oltre
  Postgres: la conseguenza "un solo servizio stateful" dell'ADR-011 vale per
  l'MVP a singola replica (default `fs`), non più incondizionatamente quando
  si opta per S3 — è un trade-off esplicito di chi scala, non il default.
- Le credenziali S3 si aggiungono alla superficie dei segreti da env (mai nel
  repo), accanto a `COORDINATOR_KEY`.
- Il job CI "integration" cresce di una suite (`apps/api`) oltre a quella
  esistente di `@mercurio/escrow`, sullo stesso `docker-compose.yml`.
