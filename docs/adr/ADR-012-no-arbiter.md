# ADR-012 — Nessun arbitro: certificazioni ai passaggi di mano + esiti deterministici

- Stato: accettato (decisione utente in revisione) — 2026-07-12
- Flussi e casi limite: [RISKS.md §1](../RISKS.md), [ARCHITECTURE.md §5](../ARCHITECTURE.md)

## Contesto

L'integrità di un pacco non è verificabile da un software (oracle problem: Bitcoin
non vede il pacco). La prima bozza prevedeva un admin della piattaforma come arbitro
delle dispute e una finestra di contestazione di 24h dopo il ritiro. Requisito
emerso in revisione: il sistema **deve funzionare senza arbitri**, e il ritiro deve
essere definitivo ("se accetti il pacco, fine").

## Decisione

Nessuno stato di disputa, nessun ruling, nessuna finestra di contestazione. Il
protocollo si regge su due meccanismi:

1. **Accetta o rifiuta, mai giudica**: a ogni passaggio di mano chi riceve può
   accettare (certifica l'integrità con foto: la custodia passa, bond e payout del
   custode precedente si sbloccano — definitivamente) o rifiutare (`handoff_reject`:
   documentato, la custodia non passa, nessun movimento di denaro). Non si prende
   mai in custodia ciò che non si è accettato.
2. **Il denaro si muove solo per regole meccaniche**: certificazione → payout;
   `pickup_timeout` / `transit_timeout` → slash del bond al mittente;
   `storage_expiry` → residuo all'hub. Valvole per gli stalli: `leg_return` (il
   vettore può sempre riconsegnare all'hub di partenza della tratta, che è tenuto a
   riaccettare ciò che ha certificato al check-out: bond restituito, nessun payout)
   e `reroute`/`boost` del mittente.

L'operatore della piattaforma **non ha alcun ruolo nei movimenti di denaro** —
nemmeno di controllo preventivo (decisione utente, RISKS §5): ogni movimento è
deciso dalle regole ed eseguito dal software, con piena tracciabilità nel ledger
e nella catena di custodia come unico presidio.

## Alternative considerate

- **Admin come arbitro (prima bozza)**: scartato — potere discrezionale sui fondi
  (con bond fino a 1.000 € = pressioni e responsabilità), collo di bottiglia umano,
  incompatibile con l'obiettivo di una piattaforma neutrale e self-hostable.
- **Arbitrato decentralizzato (giurie, oracle economici)**: complessità enorme,
  nessuna soluzione matura per beni fisici; non per un MVP.
- **Finestra di contestazione post-ritiro**: senza arbitro non c'è nessuno che possa
  deliberare sulla contestazione, quindi la finestra sarebbe teatro; l'ispezione
  avviene prima dell'OTP e l'OTP chiude. Coerente e più semplice (payout dell'ultima
  tratta immediati, niente stato `SETTLED`).

## Conseguenze

- Nessun caso in cui la piattaforma "decide": ogni movimento è prevedibile ex-ante
  leggendo le regole. I test coprono il 100% degli esiti possibili.
- **Costo dichiarato**: nei casi non provabili nessuno viene risarcito; la perdita
  resta al mittente e la reputazione punisce i recidivi. Le foto del mittente alla
  creazione sono la sua tutela documentale.
- Il rifiuto è gratuito per design (non muove denaro), quindi il griefing non paga;
  i rifiuti pesano sulla reputazione di chi li accumula.
- Semplificazione della macchina a stati: spariscono `DISPUTED`, `SETTLED` e
  l'evento `settle`; la tabella `disputes` diventa `rejections` (documentazione,
  non procedimento).
