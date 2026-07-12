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

## Dettagli implementativi (`packages/escrow`, 2026-07-12)

`PreimageCoordinator` implementa il contratto di ESCROW §5. Decisioni emerse
implementando (nessuna cambia il protocollo dei pagamenti):

1. **Vault delle preimage**: la preimage (32 byte casuali) nasce nel
   coordinatore e tocca il database solo cifrata — AES-256-GCM, chiave di
   32 byte dalla env `COORDINATOR_KEY` (64 caratteri hex, `openssl rand -hex 32`),
   formato `gcm1:` + base64(iv‖tag‖ciphertext). L'hash di pagamento è
   `SHA-256(preimage)`. La cifratura è difesa in profondità, non il confine
   di custodia: anche in chiaro, una preimage rubata può solo far incassare
   in anticipo il beneficiario legittimo (ESCROW §2).
2. **Stati osservati, non presunti**: `created → held → settled/cancelled/expired`
   avanzano interrogando il wallet del **payee** (chi ha emesso la invoice è
   l'unica fonte di verità sul suo stato): `pollOnce()` fa una passata di
   osservazione, `events()` è il loop continuo previsto dal contratto.
   `release`/`refund` transiscono in modo sincrono. LND non ha uno stato
   EXPIRED (il suo expiry watcher CANCELLA le invoice scadute): l'adapter e
   il coordinatore distinguono `expired` da `cancelled` confrontando l'ora
   con `created_at + hold_window` (più una grazia configurabile); una hold
   ancora `open` oltre la finestra viene cancellata dal coordinatore stesso
   e registrata come `expired`, così un pagamento tardivo non può atterrare.
3. **Ledger ombra per transizione** (ADR-010): ogni transizione che tocca
   fondi impegnati scrive una journal entry con chiave di idempotenza
   deterministica `cp:<paymentId>:<held|settled|refunded>`:
   `held` = [wallet payer −a, commitment spedizione +a];
   `settled` = [commitment −a, wallet payee +a];
   `cancelled/expired` = [commitment −a, wallet payer +a].
   Una hold morta senza mai essere stata accettata (`created → cancelled/expired`)
   non scrive nulla: un impegno mai nato non è un impegno (ARCHITECTURE §5,
   precisazione 1). Se invece era già _held_ quando la tratta salta, il
   coordinatore registra impegno e rimborso — entrambe osservazioni vere, a
   somma zero. Quando l'API eseguirà gli effetti `post_ledger_entry` della
   macchina a stati accoppiati agli effetti di pagamento, dovrà derivare la
   **stessa chiave** `cp:<id>:<transizione>`: le due scritture collassano in
   una e il doppio conteggio è impossibile per costruzione. La entry viene
   scritta PRIMA del flip di stato della riga: dopo un crash il retry
   ri-posta (no-op) e completa — il ledger può correre avanti di una
   transizione, mai indietro, mai due volte.
4. **Schema**: `conditional_payments` guadagna `shipment_id` (denormalizzato:
   le entry vanno sul conto commitment della spedizione senza join su
   legs/hub_stays) e `idempotency_key` unique (il parametro `idem` di
   `createConditionalPayment`: una retry restituisce la hold esistente; la
   stessa chiave con parametri diversi è rifiutata). `createConditionalPayment`
   è ripristinabile per passi: riga → invoice del payee → pagamento del payer.
5. **Il fallimento del pagamento non fallisce la creazione**: se il dispatch
   del payer fallisce (niente rotta, wallet offline), la hold resta `created`
   e muore per scadenza — il default sicuro del protocollo. `payInvoice`
   dell'adapter LND risolve al **dispatch** (primo update dello stream
   routerrpc), perché il pagamento di una hold resta volutamente in-flight.
6. **Adapter**: `fake` (rete Lightning in-memory che modella le meccaniche
   reali: i saldi si muovono solo su settle/cancel e il settle esige la vera
   preimage — usato dai test unitari e disponibile per i test di api/core) e
   `lnd_rest` (invoicesrpc `/v2/invoices/*` per le hold, routerrpc
   `/v2/router/send` per i pagamenti; byte base64 solo al confine REST, hex
   ovunque in Mercurio). L'adapter NWC di produzione resta da fare.
7. **Test**: unit su fake + pglite (`pnpm test`); integrazione su regtest
   (`pnpm test:integration`, richiede `docker compose up` + `bootstrap.sh`):
   hold pagata → held, release → il payee incassa davvero (saldo canale),
   refund → il payer rientra, scadenza → expired.
