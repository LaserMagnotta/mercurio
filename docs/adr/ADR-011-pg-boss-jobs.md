# ADR-011 — Job, timeout e code su pg-boss (Postgres), niente Redis

- Stato: accettato — 2026-07-12; **implementato** il 2026-07-13 (dettagli in fondo)

## Contesto

La macchina a stati vive di scadenze: timeout di funding, deadline di ritiro tratta,
deadline di transito, giacenza in hub, retry dell'email outbox, riconciliazione
notturna. Serve uno scheduler affidabile con
retry e persistenza.

## Decisione

**pg-boss**: coda di job persistente sopra Postgres (usa `SKIP LOCKED`), stessa
istanza del DB applicativo. Ogni transizione che apre una scadenza accoda il job
corrispondente **nella stessa transazione** della transizione: o entrambi o nessuno.
I worker girano nel processo di `apps/api` nell'MVP.

Ogni job di timeout, quando scatta, **riverifica lo stato corrente** prima di agire
(il timeout di ritiro non fa nulla se il ritiro è avvenuto): i job sono promemoria,
la verità è nella macchina a stati.

## Alternative considerate

- **BullMQ (Redis)**: ottimo, ma aggiunge un servizio stateful solo per le code e
  soprattutto perde l'atomicità job+transizione nella stessa transazione DB — che
  per gli eventi monetari è l'argomento decisivo.
- **cron di sistema + polling di tabelle scadenze**: fattibile ma reinventa retry,
  backoff e locking che pg-boss dà gratis.
- **Timer in-process (setTimeout)**: persi a ogni deploy/restart. Non idoneo a
  scadenze di giorni.

## Conseguenze

- Un solo servizio stateful (Postgres) in tutta l'infrastruttura MVP.
- Volumi di code oltre ~centinaia di job/sec richiederebbero migrazione (non è il
  nostro caso; la firma dei job è banale da portare su BullMQ se mai servisse).
- I worker sono separabili dal processo API senza cambi di codice quando servirà
  scalare.

## Dettagli implementativi (2026-07-13, `apps/api`)

L'atomicità job+transizione — l'argomento decisivo di questo ADR — è
realizzata con una piccola variante: le scadenze sono **fatti in tabella**
(`shipment_timers`, riga scritta dall'effetto `schedule_timeout` nella stessa
transazione della transizione, cancellata da `cancel_timeout`), non un job
pg-boss per scadenza. pg-boss resta il motore di esecuzione: un job cron al
minuto (`fireDueTimers`) trasforma le righe scadute negli eventi di timeout
della macchina, che riverifica stato e scadenza da sé — il timer è il
promemoria, la macchina è la verità, esattamente come sopra. Un timer reso
stantio da una transizione già avvenuta viene consumato senza effetti.

Ragioni della variante: (a) l'atomicità è garantita dalla transazione
dell'executor senza dipendere dalle API transazionali di pg-boss; (b) i
timeout sono testabili deterministicamente su pglite con orologio iniettato
(`fireDueTimers(deps, now)`), dove pg-boss non gira; (c) la granularità al
minuto basta con la finestra più corta a 60 minuti.

Gli altri worker sono cron pg-boss nello stesso processo (MVP): wallet-event
pump e dispatch dell'email outbox al minuto, retry degli `escrow_intents`
(release/refund post-commit non ancora riusciti, ADR-013) ogni 5, e la
riconciliazione notturna dell'invariante 6 alle 03:00.
