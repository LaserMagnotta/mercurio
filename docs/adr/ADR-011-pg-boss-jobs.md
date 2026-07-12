# ADR-011 — Job, timeout e code su pg-boss (Postgres), niente Redis

- Stato: proposto (in revisione) — 2026-07-12

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
