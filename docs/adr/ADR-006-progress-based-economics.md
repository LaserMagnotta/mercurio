# ADR-006 — Ripartizione proporzionale ai km di avvicinamento

- Stato: proposto (in revisione) — 2026-07-12
- Analisi completa e simulazioni: [ECONOMICS.md](../ECONOMICS.md)

## Contesto

Il compenso fisso "60% per tratta" dell'esempio canonico non generalizza al
multi-tratta: non lega il compenso ai km e affama le tratte finali. Chiarimento di
specifica (revisione utente): le percentuali degli hub si applicano **al lordo della
tratta del vettore**, non all'offerta totale. Tre modelli valutati: % fissa sul
residuo, proporzionale ai km di avvicinamento, asta per tratta.

## Decisione

**Modello B — progress-based**: ogni tratta ha un lordo `pool_residuo × Δr / r`
(= `P × Δr / D` in assenza di boost); l'hub di partenza e quello di arrivo della
tratta prelevano ciascuno la propria percentuale **dal lordo**; il vettore netta
`lordo × (1 − f_dep − f_arr)` e vede il netto prima di accettare. Regole di
contorno: progresso minimo `max(5 km, 5% D)`, solo progresso positivo, boost del
mittente se il pacco ristagna, tetto di validazione sulle fee hub, fee piattaforma
parametrica a 0%, arrotondamenti a `platform:rounding`.

## Alternative considerate

- **A — % fissa sul residuo** (l'esempio del CLAUDE.md): lordi in decadimento
  geometrico indipendente dai km → le tratte finali diventano invendibili e resta
  sempre un residuo non assegnato; premia la frammentazione (60% del pool anche per
  1 km). Scartato: strutturalmente rotto.
- **C — asta per tratta**: miglior price discovery ma UX complessa, tempi incerti,
  rischio budget esaurito a metà viaggio. Rimandato a v2 come overlay di
  negoziazione sopra il prezzo progress-based.

## Conseguenze

- Il budget del mittente è distribuito per intero fino a destinazione (conservazione
  esatta); costo totale prevedibile = `P`.
- Se tutti gli hub chiedono la stessa `f`, gli hub prendono in totale `2f × P`
  comunque venga spezzato il viaggio: aggiungere hub intermedi non erode il budget.
- Incentivi: nessun premio a frammentare; le fee hub mordono il netto del vettore →
  pressione competitiva sulle percentuali; a parità di fee il €/km netto è uniforme
  su tutte le tratte.
- **L'esempio canonico nel CLAUDE.md va aggiornato** (Luca: lordo 2,00 €,
  netto 1,60 € — non 3,00 €).
- Il €/km uniforme non prezza le tratte "difficili": mitigato dal boost;
  se i dati mostreranno pacchi sistematicamente incagliati, si attiva il modello C.
