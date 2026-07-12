# ADR-013 — Zero custodia: coordinatore per preimage e pagamenti diretti P2P

- Stato: accettato (requisito utente in revisione) — 2026-07-12
- Sostituisce: [ADR-005](ADR-005-escrow-backend-lnbits.md) (LNbits custodial)
- Design completo: [ESCROW.md](../ESCROW.md)

## Contesto

Requisito emerso in revisione: **in nessun momento il sistema deve custodire fondi**,
per non rientrare nel perimetro MiCA/PSD2 by design. Il backend LNbits (ADR-005) è
custodial per natura e va eliminato. Le obiezioni originali alle hold invoice —
lock troppo lunghi e nessun payout parziale — valevano per un escrow-pentola
prefinanziato che copre l'intera spedizione; cadono se i flussi diventano per-tratta.

## Decisione

1. **Niente prefinanziamento**: l'offerta `P` è un impegno di spesa; il denaro si
   muove tratta per tratta.
2. **Pagamenti condizionali diretti**: ogni vincolo (pagamento tratta, bond vettore,
   bond hub) è una **hold invoice tra i due utenti interessati**, con hash generato
   dal coordinatore. Rivelare la preimage al beneficiario = release; annullare =
   refund al pagatore. La piattaforma detiene solo preimage (informazione), mai sats.
3. **Fee hub pagate sul posto**: invoice istantanee vettore→hub ai passaggi di mano
   fisici; la certificazione si sblocca a pagamento avvenuto.
4. **Wallet degli utenti** connessi via NWC o adapter diretti (`WalletConnection`);
   il dominio parla solo con `EscrowCoordinator` (ESCROW §5).
5. **Giacenza massima 7 giorni nell'MVP**: il bond hub è il lock più lungo e il
   budget CLTV di un HTLC pendente deve restare sano.

## Alternative considerate

- **LNbits custodial (ADR-005)**: eliminata dal requisito R0 — custodia piena.
- **Cashu/Fedimint**: il mint/la federazione custodisce comunque (e saremmo noi).
  Eliminata da R0.
- **Escrow-pentola via un'unica hold invoice sull'intera spedizione**: lock di
  settimane e settle tutto-o-niente verso un solo beneficiario: irrealizzabile —
  è l'obiezione che aveva motivato ADR-005.
- **Pagamento diretto post-servizio senza hold**: il mittente potrebbe non pagare a
  servizio reso; il vettore lavorerebbe a credito. Scartata: con le hold il vettore
  parte solo a fondi già vincolati.

## Conseguenze

- **Il perimetro custodial MiCA/PSD2 non si applica per costruzione**; resta una
  verifica legale leggera sul profilo PISP (ESCROW §6).
- **Default sicuro**: piattaforma morta ⇒ le invoice scadono ⇒ ogni pagatore
  riprende i suoi fondi. Un attacco al DB delle preimage può solo anticipare
  incassi ai legittimi beneficiari.
- **Frizione dichiarata**: wallet hold-capable richiesti (LND/CLN/Alby Hub via NWC),
  mittente reattivo a ogni accettazione di tratta, liquidità in-flight per i bond.
  È il prezzo dello zero-custodia, accettato.
- Il ledger (ADR-010) diventa un ledger _ombra_ dei flussi esterni osservati;
  l'invariante di riconciliazione confronta scritture e stato reale delle invoice.
- `storage_expiry` non gira più nessun residuo all'hub (non esiste pentola): la
  compensazione è il pacco svincolato secondo ToS.
