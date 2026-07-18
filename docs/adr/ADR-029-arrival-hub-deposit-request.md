# ADR-029 — Accetta/Rifiuta dell'hub d'arrivo sulle richieste di deposito

- Stato: **PROPOSTA — in attesa della decisione di Giacomo.** Cambio di
  protocollo: NON implementare finché non è deciso (Fase 2 punto 8 del backlog).
- Contesto: CLAUDE.md «Hub — dettagli» (la dashboard mostra le richieste di
  deposito che l'hub accetta o no); ARCHITECTURE §4 (`auto_accept`) e §5 (riga 4
  `leg_accept`, riga 2 `origin_hub_accept`); [ADR-012](ADR-012-no-arbiter.md)
  (nessun arbitro: solo accetta o rifiuta), [ADR-013](ADR-013-non-custodial-coordinator.md)
  (zero custodia), [ADR-016](ADR-016-recipient-claim.md) (precedente di uno stato
  «pendente» fuori bacheca con finestra), [ADR-028](ADR-028-hub-venue-and-deposit-notice.md)
  (email di richiesta di deposito, già pronta a estendersi). Prepara il punto 9
  (richieste pendenti in cima alla dashboard).

## Il problema, in una riga di codice

Oggi un vettore può depositare **solo** presso un hub d'arrivo che
`auto_accept`. La guardia è esplicita, in `leg_accept`
(`packages/core/src/state-machine/state-machine.ts`):

```ts
if (!event.arrivalHubAutoAccepts || !event.arrivalHubWalletConnected) {
  return guardFailed(state, event.type,
    'arrival hub must auto-accept deposits and have a connected wallet (no human in the loop)');
}
```

Un hub che non auto-accetta **non può essere destinazione di nessuna tratta**:
sparisce di fatto dalla rete come punto di consegna intermedio o finale. È
proprio il contrario di quello che vogliamo per una rete di negozi e bar, dove
molti vorranno **vedere** cosa stanno per custodire prima di impegnarsi.

L'hub **di origine** ha già il pattern giusto: se non auto-accetta, la
spedizione resta `DRAFT` come *richiesta di deposito* nella sua dashboard, e
lui la accetta con `origin_hub_accept` (o la ignora). Il punto 8 chiede di
**estendere lo stesso «accetta / rifiuta» all'hub d'arrivo** di una tratta.

## Il vincolo che governa tutto: la fase di richiesta non muove denaro

Prima di ogni dettaglio, l'invariante che tiene insieme zero-custodia (ADR-013)
e nessun-arbitro (ADR-012):

> Durante la richiesta di deposito **non esiste nessuna hold**, il pacco **non
> si muove**, nessuno impegna un satoshi. Un rifiuto o una scadenza liquidano
> **zero** denaro.

Il vettore impegna il suo bond, e l'hub d'arrivo il proprio, **solo dopo**
l'accettazione dell'hub, esattamente come oggi in `leg_accept`. Così il rifiuto
non è mai una disputa su fondi (ADR-012) e non lascia mai un msat in limbo
(ARCHITECTURE §5 inv. 2). È un «no grazie» a costo zero, come il rifiuto
dell'hub di origine.

## Proposta

### 1. Una fase nuova PRIMA del funding: la tratta «richiesta»

Oggi: `AT_HUB —leg_accept→ (pending_funding) —leg_funded→ LEG_BOOKED`.

Proposto, per un hub d'arrivo **manuale**:

```
AT_HUB —leg_request→ [leg: requested]         (fuori bacheca, timer di risposta armato)
         —deposit_accept (hub)→ (pending_funding) —leg_funded→ LEG_BOOKED   [come oggi]
         —deposit_reject (hub) / deposit_request_expired (worker) / deposit_request_cancel (vettore)→
              [leg: expired] la spedizione TORNA in bacheca, AT_HUB, zero denaro
```

- **`leg_request`** (vettore): crea la riga `legs` in stato **`requested`** con
  il **prezzo congelato** (netto, fee dei due hub, premio) — così il vettore
  vede subito cosa incasserebbe — ma **senza nessuna hold**. Arma un timer
  `deposit_response` e toglie la spedizione dalla bacheca (è «prenotata» da
  questo vettore, come una tratta in funding o un claim pendente — ADR-016).
  Guardie identiche a `leg_accept` di oggi, **tranne** che la guardia
  «l'hub deve auto-accettare» sparisce: resta solo «wallet dell'hub connesso»
  (deve poter bloccare il bond dopo, se accetta). Evento di catena
  `deposit_requested`.
- **`deposit_accept`** (proprietario dell'hub d'arrivo): è **esattamente
  l'effetto di `leg_accept` di oggi** — crea le 3–4 hold (pagamento tratta,
  bond vettore, bond hub d'arrivo, ed eventuale Π_h sull'ultima tratta), arma il
  timer `leg_funding` (60 min), disarma `deposit_response`, porta la tratta in
  `pending_funding`. Da qui in poi **niente cambia**: `leg_funded` → `LEG_BOOKED`,
  checkout, transito, check-in. Evento `leg_accepted` (riuso).
- **`deposit_reject`** (hub) / **`deposit_request_expired`** (worker sul timer) /
  **`deposit_request_cancel`** (vettore, per ri-mirare in fretta): la tratta va
  in `expired` (nessuna hold è mai esistita: dissoluzione a costo zero, come
  `leg_funding_expired`), la spedizione **torna in bacheca `AT_HUB`**, il vettore
  è avvisato e sceglie un altro hub. Rifiuto e scadenza scrivono una riga
  `rejections` con `stage = deposit_request` (documentazione, non un giudizio —
  ADR-012); nessun evento monetario.

### 2. `auto_accept` diventa «pre-consenso a `deposit_accept`»

`auto_accept = true` non è più un requisito per essere destinazione: diventa
**opt-in** «accetto sempre». Alla `leg_request` verso un hub `auto_accept`,
l'API fa scattare subito anche `deposit_accept` (come già fa alla creazione per
l'hub di origine, ARCHITECTURE §5 prec. 13): si va dritti al funding, **identico
al comportamento di oggi**. Verso un hub manuale, ci si ferma su `requested` e
si aspetta. Nessuna regressione per chi auto-accetta.

### 3. La bacheca include gli hub manuali, marcati «richiede conferma»

Oggi la bacheca (MATCHING §3) può proporre come drop solo hub `auto_accept`.
Con questa proposta include anche i manuali, ma la card del drop li **marca**
(«conferma dell'hub necessaria»): il vettore sa che scegliendoli non prenota
all'istante ma apre una richiesta. Gli hub `auto_accept` restano i più comodi
(prenotazione immediata) — un incentivo di mercato naturale a tenere
`auto_accept` o a rispondere in fretta.

### 4. Simmetria con il punto 6 e il punto 9

La *richiesta di deposito* diventa un concetto **unico** per hub di origine e
hub d'arrivo: stessa email `hub_deposit_request` (ADR-028 — già predisposta),
stessa voce nella dashboard. Il **punto 9** (richieste pendenti in cima ed
evidenziate) si implementa insieme a questo: la sezione «Richieste di deposito»
raccoglie sia le `DRAFT` all'origine (già oggi) sia le tratte `requested` in
arrivo, ordinate per **scadenza di risposta** più vicina e in evidenza.

## Le decisioni aperte (servono a Giacomo)

### A. Timeout di risposta — default proposto: **30 minuti** (wall-clock)

Trade-off: troppo lungo e la spedizione resta fuori bacheca e il vettore
aspetta; troppo corto e un negozio umano non fa in tempo → auto-rifiuto e hub
manuali inutili.

- **30 min (raccomandato per l'MVP)**: stessa famiglia della finestra di funding
  (60 min), tiene la spedizione liquida, il vettore può annullare e ri-mirare.
- **2 ore**: più realistico per un'attività fisica, ma spedizione fuori bacheca e
  vettore in attesa più a lungo.
- **A ore di apertura** (usando gli orari del punto 5): «l'hub ha X ore *di
  apertura* per rispondere». Elegante e giusto, ma richiede matematica del timer
  consapevole degli orari — lo terrei come evoluzione, non MVP.

### B. Default di `auto_accept` per i nuovi hub — proposto: **resta `true`**

«opt-in» nel brief può voler dire due cose: (i) `auto_accept` *resta disponibile*
come scelta (default invariato `true`), oppure (ii) si *entra* nell'auto-accept
di proposito (default `false`, ogni hub rivede ogni deposito). Raccomando **(i)
default `true`**: minima sorpresa, massima liquidità, e chi vuole rivedere
disattiva. Se preferisci il default sicuro `false`, si cambia una costante.

### C. La bacheca durante una richiesta pendente — proposto: **esclusiva**

- **Esclusiva (raccomandata)**: come il claim (ADR-016), la spedizione esce dalla
  bacheca mentre una richiesta è pendente; il timeout limita l'attesa. Semplice,
  nessuna corsa, zero-custodia banale.
- **Non esclusiva**: la spedizione resta in bacheca, più vettori possono
  richiedere, il primo accept dell'hub vince e gli altri decadono. Più liquida
  ma con gestione della corsa e notifica ai «perdenti». La terrei per dopo.

### D. «e ritiro»: cosa intendi? — la mia lettura e una domanda

Il brief dice «richieste di deposito **e ritiro**». Il **deposito** è chiaro:
l'hub d'arrivo che accetta il pacco in entrata (questa proposta). Il **ritiro**
è l'hub **di partenza** che consegna il pacco al vettore: ma quello è **già** un
accetta/rifiuta, in tempo reale, con il **check-out a doppia conferma** (l'hub
certifica con foto cosa consegna, il vettore conferma; l'hub può rifiutare con
`handoff_reject` stage `pickup_checkout`, ARCHITECTURE §5 riga 12).

Raccomando di **non** aggiungere un secondo handshake asincrono di ritiro
(raddoppierebbe le conferme e la latenza per un guadagno minimo: l'hub di
partenza ha già il pacco e vuole liberarsene, e il rischio del vettore è coperto
da bond + reputazione). Ma è una tua scelta: vuoi che «ritiro» significhi (i) il
gate di check-out esistente è sufficiente [raccomandato], oppure (ii) un
accetta/rifiuta **asincrono** dell'hub di partenza *prima* che il vettore si
muova a ritirare?

## Cosa toccherebbe l'implementazione (per scoping — non ancora fatto)

- **Enum (solo ADD, trappola nota)**: `leg_status` += `requested`;
  `custody_event_type` += `deposit_requested` (l'accept riusa `leg_accepted`);
  `shipment_timer_kind` += `deposit_response`; `rejection_stage` += `deposit_request`.
- **`packages/core` (macchina a stati)**: eventi `leg_request`, `deposit_accept`,
  `deposit_reject`, `deposit_request_expired`, `deposit_request_cancel`; spostare
  la creazione delle hold da `leg_accept` a `deposit_accept`; la richiesta pendente
  respinge `leg_request`/`recipient_claim`/`boost`/`reroute`/`cancel` concorrenti,
  come già fa una tratta pendente o un claim (guardie speculari a `pendingClaim`).
- **`apps/api`**: rotte `POST /shipments/:id/legs` (ora crea `requested` e, se
  l'hub auto-accetta, fa scattare subito `deposit_accept`),
  `POST /shipments/:id/legs/:legId/deposit-accept|deposit-reject`,
  `.../deposit-cancel`; timer `deposit_response` nello sweep worker; email
  `hub_deposit_request` all'hub d'arrivo (riuso ADR-028); bacheca che include gli
  hub manuali.
- **`apps/web`**: dashboard hub con le richieste di deposito in arrivo (accetta/
  rifiuta) in cima ed evidenziate (**punto 9**); bacheca vettore che marca i drop
  «richiede conferma» e mostra lo stato «in attesa dell'hub».
- **Test (rigore da denaro, ADR-010/013)**: `leg_request` → `deposit_reject`/
  timeout/cancel = **zero** hold, zero journal entry, spedizione di nuovo in
  bacheca; `deposit_accept` = identico bit-per-bit a `leg_accept` di oggi (stesse
  hold, stesso ledger); property test: nessuna richiesta rifiutata o scaduta tocca
  il ledger.

## Alternative considerate

- **Accettazione all'arrivo (dopo il trasporto)**: l'hub decide quando il pacco
  è già lì. Un rifiuto lascerebbe il pacco **incagliato** in mano al vettore
  lontano da casa. Contro «la spedizione resta AT_HUB». Scartata.
- **Tenere il bar attuale e basta migliorare l'UX**: non risolve il problema —
  gli hub manuali restano non-destinazioni. Scartata.
- **Bond dell'hub d'arrivo bloccato già alla richiesta (per «prenotare» lo
  spazio)**: metterebbe denaro in volo prima dell'accettazione, cioè un impegno
  che un rifiuto dovrebbe poi sciogliere — rompe la semplicità «la richiesta non
  muove denaro» e riapre la porta a msat in limbo. Scartata.

## Conseguenze

- Gli hub manuali diventano nodi a pieno titolo della rete: la reputazione
  (ADR-027, solo hub) e il timeout gestiscono l'hub che non risponde, senza
  arbitro — coerente con RISKS §7.
- Nessun cambiamento al motore dei pagamenti né al ciclo dopo `deposit_accept`:
  la superficie sensibile (le hold) è esattamente quella di oggi, solo spostata
  di una transizione più in là.
- Il punto 9 diventa naturale: un solo tipo di «richiesta di deposito» da
  mettere in cima alla dashboard, con la scadenza di risposta come ordinamento.
