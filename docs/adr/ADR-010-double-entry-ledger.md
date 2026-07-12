# ADR-010 — Ledger a partita doppia in Postgres, unica sorgente dei movimenti

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Requisito del CLAUDE.md: "ogni movimento passa dal ledger", "nessuna logica di denaro
senza test". Con l'architettura zero-custodia (ADR-013) i fondi vivono nei wallet
degli utenti: il ledger è quindi un **ledger ombra** — la contabilità autorevole di
ciò che il protocollo ha impegnato e di ciò che i wallet hanno effettivamente
regolato.

## Decisione

Partita doppia classica su tre tabelle (`accounts`, `journal_entries`, `postings` —
ARCHITECTURE §4):

- Ogni evento della macchina a stati che muove denaro produce **una** journal entry
  con ≥ 2 postings che **sommano a zero** (trigger DB, non solo codice).
- Conti per: wallet esterni degli utenti (`external_wallet`) e impegni per
  spedizione (`commitment`). **Nessun conto della piattaforma**: la sua assenza è
  un invariante testato (ARCHITECTURE §5).
- `idempotency_key` unica per entry: wallet-event e retry non possono duplicare
  movimenti.
- Il ledger è **append-only**: le correzioni sono storni (entry contrarie), mai UPDATE.
- Job di riconciliazione: lo stato di ogni `conditional_payment` registrato coincide
  con lo stato reale dell'invoice nel wallet dell'emittente; divergenza = alert
  bloccante.

## Alternative considerate

- **Saldo come colonna aggiornata (partita semplice)**: veloce da scrivere,
  impossibile da auditare; un bug lascia un numero sbagliato senza storia. Scartato.
- **Event sourcing completo dell'applicazione**: il ledger + `custody_events`
  hash-concatenati danno già l'auditabilità che serve, senza il costo di ricostruire
  tutto lo stato dagli eventi.
- **Ledger dedicato esterno (es. TigerBeetle)**: interessante a volumi alti; per
  l'MVP un secondo datastore è complessità ingiustificata.

## Conseguenze

- Ogni bug monetario è diagnosticabile: la storia completa è nelle entry.
- I test di dominio asseriscono invarianti globali (conservazione per spedizione,
  somma zero, riconciliazione) su ogni scenario della macchina a stati.
- Piccolo costo di verbosità: anche i movimenti banali richiedono entry — è il punto.
