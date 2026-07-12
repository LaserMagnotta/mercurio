# ADR-008 — Importi in satoshi (msat nel DB), EUR solo per input e display

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Gli utenti ragionano in euro ("spedizione da 5 €", "0,20 €/km"), ma tutti i pagamenti
avvengono in sats su Lightning. Serve una convenzione unica per evitare doppie
contabilità e ambiguità (la Bitcoin Design Guide impone importi in sats mai ambigui).

## Decisione

- **Unità contabile: millisatoshi (`bigint`)** in DB e in tutto `packages/core`
  (msat è l'unità nativa di Lightning; il sat è l'unità delle invoice, arrotondando
  per difetto al congelamento degli importi di tratta).
- L'offerta è inserita in EUR e **convertita in sats alla creazione della
  spedizione**; il cambio (valore, fonte, timestamp) è congelato e usato per tutta
  la sua vita: percentuali e €/km si valutano su quel cambio. Nessun ricalcolo a
  cambio corrente a metà viaggio.
- UI: sats sempre visibili come importo vero, EUR come controvalore indicativo
  (pattern "Daily spending wallet").
- Fonte cambio: mediana di più provider con cache; la fonte è registrata nello
  snapshot.

## Alternative considerate

- **Contabilità in EUR con conversione ai pagamenti**: crea disallineamenti tra
  ledger e fondi reali (il ledger DEVE riconciliare al msat col backend Lightning).
- **Cambio corrente a ogni evento**: le quote delle tratte cambierebbero durante il
  viaggio → contestazioni; il congelamento rende ogni importo verificabile ex-ante.
- **Numeric/decimal per gli importi**: `bigint` msat è esatto e senza sorprese di
  arrotondamento; i decimali restano solo nei campi percentuale.

## Conseguenze

- Chi incassa si assume il rischio di cambio sats/EUR dalla creazione all'incasso:
  esplicitato in UI e ToS (RISKS §7).
- Tutti gli importi di test e simulazione sono interi msat: proprietà di
  conservazione verificabili all'unità.
