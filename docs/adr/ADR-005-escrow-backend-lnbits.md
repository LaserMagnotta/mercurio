# ADR-005 — Backend escrow MVP: LNbits dietro interfaccia `EscrowBackend`

- Stato: **superseded da [ADR-013](ADR-013-non-custodial-coordinator.md)** — 2026-07-12
  (requisito utente: zero custodia in ogni momento; LNbits è custodial per natura)
- Analisi storica; il design attuale è in [ESCROW.md](../ESCROW.md)

## Contesto

Escrow e bond devono: durare giorni/settimane (R1), pagare a rate più beneficiari
(R2), supportare release/slash (R3), con esito deciso dalla piattaforma (R4), UX
semplice (R5), tutto open source (R6). Opzioni valutate: hold invoice stile RoboSats,
LNbits custodial, ecash (Cashu/Fedimint).

## Decisione

**LNbits self-hosted** sopra `lnd-platform`: saldi interni per utente, escrow e bond
come hold contabili gestiti dal nostro ledger a partita doppia. Tutto il dominio parla
solo con l'interfaccia **`EscrowBackend`** (ESCROW.md §5), progettata per reggere anche
backend hold-invoice ed ecash.

Motivo dirimente: le hold invoice non soddisfano R1 (HTLC pendenti per settimane =
liquidità congelata e rischio force-close) né R2 (settle tutto-o-niente, nessuno
split); l'ecash non riduce la custodia dell'MVP (il mint saremmo noi) e aggiunge
complessità. LNbits è l'unica opzione che soddisfa R1+R2 oggi con complessità bassa.

## Alternative considerate

Vedi tabella comparativa in ESCROW.md §3 (custodia, fiducia, UX, complessità,
rischio normativo). In sintesi: hold invoice = giusta per escrow di ore, non di
settimane; Cashu/Fedimint = roadmap giusta per ridurre custodia, non un MVP.

## Conseguenze

- **Custodia piena** → mitigazioni obbligatorie: incentivo al prelievo/auto-inoltro,
  riconciliazione notturna, ⚖️ parere legale MiCA/PSD2 prima del mainnet (RISKS §5).
  Nessun controllo preventivo sui movimenti (RISKS §5). Con bond fino a 1.000 €
  (decisione utente) l'esposizione è dominata dai bond: la v1.1 hold-invoice è
  prioritaria.
- Payout per tratta istantanei e gratuiti (movimenti interni): l'esperienza "consegno
  e incasso subito" è il vantaggio competitivo di questa scelta.
- Roadmap: v1.1 bond brevi via hold invoice (stessa interfaccia), v2 backend Cashu.
- Serve un processo operativo per il nodo (liquidità canali, backup, hot/cold split).
