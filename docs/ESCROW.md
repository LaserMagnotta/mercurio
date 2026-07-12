# Mercurio — Pagamenti condizionali senza custodia

> Stato: **approvato in revisione** — 2026-07-12 (rev. 3: requisito utente "in nessun
> momento il sistema custodisce fondi" → il backend custodial LNbits è eliminato).
> Decisione formalizzata in [ADR-013](adr/ADR-013-non-custodial-coordinator.md)
> (che sostituisce [ADR-005](adr/ADR-005-escrow-backend-lnbits.md)).

## 1. Requisito fondante e requisiti derivati

**R0 — Zero custodia (vincolo assoluto)**: in nessun momento la piattaforma detiene,
riceve o instrada fondi degli utenti. È la garanzia che il perimetro MiCA/PSD2 sulla
custodia non si applica per costruzione, non per mitigazione (RISKS §5).

| Requisito | Perché |
|---|---|
| **R1 — Vincoli per la durata di una tratta/giacenza** | i lock servono per ore/giorni, non per l'intera spedizione |
| **R2 — Ogni tratta paga i suoi attori** | vettore e hub incassano al completamento del loro pezzo |
| **R3 — Bond con release/slash deterministici** | liberato se tutto ok, incamerato dal beneficiario fissato ex-ante altrimenti (ADR-012) |
| **R4 — Esiti eseguiti dal protocollo** | mai un giudizio umano, mai la piattaforma come beneficiaria |
| **R5 — UX sostenibile** | pattern Bitcoin Design Guide; frizione dichiarata, non nascosta |
| **R6 — Open source e self-hostable** | vincolo di progetto |

Con R0 le opzioni custodiali muoiono in partenza: **LNbits** (saldi interni = custodia
piena) e **Cashu/Fedimint** (il mint/la federazione detiene i sats — e il mint saremmo
noi). Resta la famiglia delle **hold invoice**, che nella prima analisi era stata
scartata per due obiezioni: lock troppo lunghi (R1) e nessun payout parziale (R2).
Entrambe si risolvono ristrutturando i flussi: **niente escrow-pentola prefinanziato,
ma pagamenti diretti per-tratta**, coordinati per preimage.

## 2. Il meccanismo: coordinatore per preimage

Una hold invoice è una invoice il cui incasso resta sospeso finché chi la ha emessa
non conosce la **preimage** dell'hash di pagamento. Il trucco di Mercurio: **la
preimage la genera il coordinatore** (la piattaforma) e la consegna al beneficiario
solo quando la regola del protocollo lo prevede.

- Il **pagatore** paga la hold invoice: i suoi fondi restano in-flight, vincolati
  verso il **beneficiario fissato all'emissione** (chi ha emesso l'invoice).
- Esito positivo per il beneficiario → il coordinatore gli **rivela la preimage** e
  lui incassa, direttamente dal pagatore.
- Esito negativo → il coordinatore non rivela nulla: l'invoice viene annullata (o
  scade) e i fondi **tornano al pagatore** senza essere mai transitati altrove.

Proprietà chiave:
- La piattaforma **non può dirottare fondi verso di sé**: può solo accelerare o
  negare un esito tra due controparti già fissate. Non è mai nel flusso di denaro.
- **Default sicuro**: se la piattaforma sparisce, ogni hold invoice scade e ogni
  pagatore riprende i suoi fondi. Il fallimento del coordinatore non perde denaro.
- Un attaccante che ruba il database delle preimage può solo far incassare i
  legittimi beneficiari in anticipo: bottino zero (RISKS §7).

## 3. I flussi di Mercurio, tratta per tratta

Non esiste più il funding iniziale dell'offerta: l'offerta `P` è un **impegno di
spesa** (pubblicato e vincolante via ToS), pagato tratta per tratta.

### All'accettazione di una tratta (`leg_accept` → `leg_funded`, finestra ~60 min)

| # | Hold invoice | Emessa da | Pagata da | Importo |
|---|---|---|---|---|
| 1 | Pagamento tratta | Vettore | **Mittente** | lordo tratta (ECONOMICS §3) |
| 2 | Bond vettore | Mittente | **Vettore** | bond di custodia |
| 3 | Bond hub di arrivo | Mittente | **Hub di arrivo** | bond di custodia (copre la giacenza successiva) |

Tutte e tre con hash generati dal coordinatore. Quando tutte risultano *held*, la
tratta è prenotata (`LEG_BOOKED`); se la finestra scade, tutto viene annullato e la
spedizione resta in bacheca. Il vettore **non si muove mai senza che il pagamento
della tratta sia già vincolato**: non lavora a credito.

### Ai passaggi di mano fisici (le due parti sono presenti)

Le fee degli hub si pagano **sul posto, direttamente vettore → hub**, con invoice
istantanee normali (qualsiasi wallet): l'app mostra l'invoice e sblocca la
certificazione solo a pagamento avvenuto.

- **Check-out** (ritiro dall'hub): il vettore paga la fee di partenza
  (`f_dep × lordo`); il bond dell'hub cedente viene annullato (release).
- **Check-in** (deposito nell'hub successivo): il vettore paga la fee di arrivo;
  l'hub certifica l'integrità; a certificazione avvenuta il coordinatore **rivela la
  preimage al vettore**, che incassa il lordo direttamente dal mittente; il bond del
  vettore viene annullato. Il vettore netta `lordo − fee` esattamente come nel
  modello economico.

### Esiti negativi (deterministici, ADR-012)

- `pickup_timeout` / `transit_timeout`: il coordinatore rivela al **mittente** la
  preimage del bond del vettore → il mittente incassa il bond direttamente dal
  vettore; il pagamento della tratta viene annullato (torna al mittente).
- `leg_return`: pagamento tratta e bond annullati, nessun incasso per nessuno.
- `storage_expiry`: il bond dell'hub viene annullato e il pacco è **svincolato**
  secondo ToS: il bene stesso è la compensazione dell'hub (non esiste un escrow
  prefinanziato da girargli).
- `cancel` (all'hub di origine): il mittente paga la compensazione `f_o × P`
  direttamente all'hub; la restituzione del pacco si sblocca al pagamento.
- `boost` / `reroute`: nessun movimento di denaro — cambiano solo l'impegno di
  spesa e il calcolo delle tratte future.

## 4. Cosa comporta (onestamente)

| Tema | Implicazione | Gestione |
|---|---|---|
| **Wallet degli utenti** | Emettere hold invoice richiede un wallet capace (LND, Core Lightning, Alby Hub…): serve a mittenti (bond), vettori (pagamento tratta). Pagarle richiede wallet che tollerino pagamenti pendenti | Connessione via **NWC (Nostr Wallet Connect)** + adapter diretti (REST LND); guida all'onboarding; in dev: un LND regtest per utente. È il prezzo dichiarato dello zero-custodia |
| **Durata dei lock (R1)** | Il lock più lungo è il bond hub = intera giacenza. HTLC di settimane = liquidità congelata e rischio force-close | **Giacenza massima 7 giorni nell'MVP** (budget CLTV sano); rinnovo rolling del bond come evoluzione |
| **Mittente reattivo** | A ogni `leg_accept` il mittente deve pagare/emettere entro la finestra | Notifiche push/email; metrica di reattività del mittente visibile in bacheca (un mittente lento = spedizione poco appetibile) |
| **Liquidità in-flight** | I bond bloccano liquidità sui canali di chi li paga per ore/giorni | Dimensionamento del bond a discrezione del mittente: il mercato prezza |
| **Fee di rete LN** | Ogni pagamento diretto paga le sue routing fee | Importi piccoli, rotte corte; mostrate in UI, mai nascoste |

## 5. Interfaccia astratta

Il dominio parla solo con queste interfacce; gli adapter concreti (NWC, LND diretto
per dev/regtest, futuri) sono in `packages/escrow`.

```ts
// packages/escrow/src/types.ts — contratto, non implementazione

/** A user's own wallet, connected via NWC or a direct node adapter.
 *  Mercurio never holds funds: it only asks the user's wallet to act. */
export interface WalletConnection {
  makeHoldInvoice(amountMsat: bigint, hash: Hex, expiry: Duration, memo: string): Promise<{ bolt11: string }>;
  makeInvoice(amountMsat: bigint, memo: string): Promise<{ bolt11: string }>;   // instant (hub fees)
  payInvoice(bolt11: string, maxFeeMsat: bigint): Promise<PaymentHandle>;       // may stay pending (hold)
  settleHoldInvoice(preimage: Hex): Promise<void>;
  cancelHoldInvoice(hash: Hex): Promise<void>;
  lookupInvoice(hash: Hex): Promise<'open' | 'held' | 'settled' | 'cancelled' | 'expired'>;
}

/** The coordinator: generates and guards preimages, never touches money.
 *  Every state change is mirrored as a double-entry shadow-ledger entry. */
export interface EscrowCoordinator {
  createConditionalPayment(params: {
    payerId: string;                       // pays the hold invoice
    payeeId: string;                       // issued it; gets the preimage on release
    amountMsat: bigint;
    purpose: 'leg_payment' | 'custody_bond';
    ref: { type: 'leg' | 'hub_stay'; id: string };
    holdWindow: Duration;
    idem: string;
  }): Promise<ConditionalPaymentId>;

  /** Reveal the preimage to the payee: they settle and receive directly from the payer. */
  release(id: ConditionalPaymentId, idem: string): Promise<void>;

  /** Cancel the hold: funds return to the payer, untouched. */
  refund(id: ConditionalPaymentId, idem: string): Promise<void>;

  /** Wallet-observed events: payment_held, settled, cancelled, expired.
   *  Core advances the state machine on these. */
  events(): AsyncIterable<CoordinatorEvent>;
}
```

Il **ledger a partita doppia** (ADR-010) resta obbligatorio ma diventa un *ledger
ombra*: registra impegni e regolamenti osservati tra wallet esterni; la
riconciliazione confronta lo stato delle invoice nei wallet con le scritture.

## 6. Profilo normativo risultante

- **Custodia**: mai — fondi sempre nel wallet del pagatore o in-flight verso il
  beneficiario fissato. Il perimetro custodial MiCA/PSD2 non si applica per
  costruzione.
- ⚖️ **Verifica residua (leggera)**: che l'orchestrazione via NWC non qualifichi la
  piattaforma come servizio di disposizione di ordini di pagamento (PISP, PSD2) —
  argomento di difesa: ogni pagamento è approvato dall'utente nel *proprio* wallet,
  la piattaforma propone, non dispone. Da confermare col legale, rischio molto
  ridotto rispetto all'ipotesi custodial.
- **AML**: nessun fondo di clienti detenuto; resta la piena tracciabilità interna
  (ledger + catena di custodia) come unico presidio (RISKS §5).
