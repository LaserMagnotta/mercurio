# ADR-026 — Giacenza in giorni, e la strada per arrivare a 30 giorni senza rompere lo zero-custodia

- Stato: **accettato** — 2026-07-17 (decisione di Giacomo). **Parte 1
  implementata** lo stesso giorno: unità in giorni con cap 7, nessun cambio di
  protocollo. **Parte 2 implementata il 2026-07-19** con il rinnovo rolling
  del bond (opzione A del §3) — dettagli, parametri e limiti noti in
  [ADR-033](ADR-033-rolling-bond-renewal.md); `MAX_STORAGE_DAYS` è ora 30.
- Contesto: backlog UX 2026-07-17 punto 2 («giacenza in giorni», range 1–30);
  ESCROW.md §4 (durata dei lock, «giacenza massima 7 giorni nell'MVP», «rinnovo
  rolling del bond come evoluzione»); ADR-013 (zero custodia, ADR-011 (timer
  su pg-boss); ARCHITECTURE.md §5 precisazione 9 (mai restringere in silenzio
  la finestra del mittente); TOS.md §10 (svincolo di fine giacenza, «fino a 7
  giorni», tariffa extra «1/30 del tetto di valore per ogni giorno»)

## Contesto

Il punto 2 chiede due cose diverse, che conviene separare perché hanno costi
opposti:

1. **Unità in giorni.** Oggi il mittente sceglie `max_storage_hours` e la UI gli
   fa scrivere «168 ore». Nessuno pensa la giacenza in ore. È un cambio di
   **leggibilità**, a costo zero di protocollo: la colonna, le validazioni, i
   form, le visualizzazioni e il timer passano da ore a giorni, e i preavvisi
   72/24 h di ADR-011 restano in ore ma partono dalla nuova unità.

2. **Range 1–30 giorni.** Qui casca il vincolo. Il tetto attuale **non è una
   scelta di UI**: è il budget CLTV del bond dell'hub. Il bond dell'hub è una
   hold invoice che resta *in volo per tutta la giacenza* (ESCROW §3, §4). Una
   HTLC che deve vivere 30 giorni chiede un delta CLTV enorme (~4300 blocchi):
   molti nodi di instradamento rifiutano CLTV così lunghi, la liquidità del
   pagatore resta congelata un mese, e cresce il rischio di force-close. ESCROW
   §4 fissa perciò **7 giorni** come «budget CLTV sano» per l'MVP e cita il
   «rinnovo rolling del bond» come l'evoluzione che scioglie il vincolo.

In codice il tetto vive in tre punti allineati: `MAX_STORAGE_HOURS = 7 * 24`
(`packages/shared/src/protocol.ts`), il cap `.max(MAX_STORAGE_HOURS)` sulla
creazione e `.max(168)` sulla registrazione hub (`routes/me.ts`, col commento
«ESCROW.md sec.4 CLTV budget»). In `docs/legal/TOS.md` §10 il numero è scritto
per esteso — «fino a 7 giorni», più la finestra di recupero di 7 giorni e la
tariffa extra «1/30 del tetto di valore per ogni giorno». Estendere a 30 giorni
tocca quindi anche il testo legale.

**Perché serve un ADR e non basta cambiare una costante.** Alzare il cap a 30
senza toccare il bond significherebbe far scegliere al mittente una giacenza che
l'hub *non può garantire*: la sua hold invoice non reggerebbe in volo per un
mese, o non verrebbe instradata affatto. Sarebbe la violazione speculare della
precisazione 9 di ARCHITECTURE §5 (là «mai restringere in silenzio la finestra
del mittente»; qui la si *prometterebbe* senza poterla mantenere) e romperebbe
la proprietà di default sicuro dello zero-custodia. Il tetto e il meccanismo del
bond sono la stessa decisione.

## Decisioni

### 1. L'unità della giacenza diventa il giorno

`max_storage_hours → max_storage_days` sia su `shipments` sia su `hubs`;
migrazione che converte l'esistente **arrotondando per eccesso**
(`ceil(hours/24)`), così nessuna finestra già accettata si accorcia. Il vincolo
`hub.maxStorage ≥ giacenza scelta dal mittente` (ARCHITECTURE §5 prec. 9) resta,
ora in giorni. Il timer `storage` continua a essere armato a un istante assoluto
(`storage_deadline_at`): internamente non cambia niente, si calcola
`giorni × 24 h` una volta sola al check-in, e i preavvisi 72/24 h partono da lì.

Questa parte **non tocca l'escrow** ed è pronta da implementare a qualunque
tetto.

### 2. Il tetto: 30 giorni è l'obiettivo, ma è gated sul bond

Il range di destinazione è **1–30 giorni** (richiesta del backlog). Non è
raggiungibile finché il bond dell'hub è una singola hold invoice lunga quanto la
giacenza. La proposta è di arrivarci in **due tempi**, con una sola migrazione
d'unità:

- **Subito, senza cambio di protocollo**: unità in giorni con **cap 7**
  (`MAX_STORAGE_DAYS = 7`, la conversione esatta del budget CLTV odierno). Il
  mittente guadagna «3 giorni» al posto di «72 ore» senza che nulla nell'escrow
  cambi. TOS §10 resta corretto (7 giorni, solo riscritto nell'unità).
- **Dopo la decisione sul bond (§3)**: si alza `MAX_STORAGE_DAYS` a 30. È una
  costante + le validazioni + il testo TOS; **nessuna nuova migrazione di
  schema**, perché la colonna è già in giorni. Il lavoro vero è nell'escrow, non
  qui.

Alzare il cap senza il §3 è escluso: prometterebbe una finestra che il bond non
regge.

### 3. Il meccanismo del bond per superare i 7 giorni — DECISO: opzione A

Tre opzioni per far vivere il bond dell'hub oltre il budget CLTV di una singola
HTLC. **Giacomo ha scelto l'opzione A (rinnovo rolling)** il 2026-07-17: finestra
di rinnovo di default 7 giorni, mancato rinnovo trattato come `storage_expiry`
anticipato (TOS §10). L'implementazione resta fuori scope in questa sessione (è
un cambio all'escrow) e avrà il suo ADR dedicato; qui si registra la direzione.

| Opzione | Come | Pro | Contro |
| --- | --- | --- | --- |
| **A. Rinnovo rolling del bond** *(raccomandata — è l'evoluzione già prevista da ESCROW §4)* | Il bond dell'hub è una catena di hold invoice a finestre corte (es. ≤7 giorni). A ogni finestra il coordinatore chiede all'hub di ri-vincolare la successiva prima che la precedente scada; l'hold vecchia si annulla, la nuova entra. Ogni HTLC resta dentro un CLTV sano. | Nessuna HTLC lunga: zero rischio di force-close e di rifiuto d'instradamento. Coerente con lo zero-custodia (ogni finestra è ancora un vincolo diretto pagatore→beneficiario). La giacenza si può allungare quanto si vuole, non solo a 30. | Un timer di rinnovo in più per stay (ADR-011). Va deciso **cosa succede se l'hub non rinnova**: la proposta è che il pacco diventi svincolabile a quella finestra come a fine giacenza (TOS §10), cioè il mancato rinnovo è un `storage_expiry` anticipato — l'hub che non ri-vincola dichiara di non voler più custodire. Richiede una riga di stato del rinnovo e un evento di catena di custodia. |
| **B. Singola HTLC lunga (alza il budget CLTV a ~30 giorni)** | Si allarga la finestra della hold del bond fino a 30 giorni. | Codice minimo: una costante di finestra. | Fragile dove conta: molti nodi cap­pano il CLTV massimo instradabile ben sotto i ~4300 blocchi; liquidità dell'hub congelata un mese; force-close più probabili. Sposta il rischio sull'utente e in silenzio. **Scartata.** |
| **C. Ri-bond a checkpoint di giacenza** | Variante di A senza catena automatica: la giacenza lunga è spezzata in segmenti; al confine di segmento l'hub ri-vincola esplicitamente, altrimenti svincolo. | Meno automatismo del coordinatore. | Più attriti per l'hub (azione manuale ricorrente) e stessa complessità di stato di A senza il vantaggio dell'automatismo. **Scartata a favore di A.** |

**Raccomandazione: A (rinnovo rolling).** È ciò che ESCROW §4 aveva già indicato
come la strada, è l'unica che non sposta rischio sull'utente, e generalizza
oltre i 30 giorni. La decisione aperta dentro A è il **default della finestra di
rinnovo** (proposta: 7 giorni, lo stesso budget CLTV di oggi) e la **conferma che
il mancato rinnovo = svincolo anticipato** secondo TOS §10.

## Cosa tocca l'implementazione (per scoping, non è ancora fatto)

Parte 1 (unità in giorni, cap 7) — pronta:

- `packages/db`: `shipments.max_storage_days` e `hubs.max_storage_days`
  (rename), migrazione con `ceil(hours/24)` sull'esistente e sui default.
- `packages/shared`: `MAX_STORAGE_DAYS` (=7) al posto di `MAX_STORAGE_HOURS`;
  `createShipmentBody.maxStorageDays` `.min(1).max(MAX_STORAGE_DAYS)`; i DTO
  (`meShipmentDto`? no — non lo espone; `shipmentDetailDto`, `hubDto`,
  `HubAcceptRequest`) passano a `maxStorageDays`.
- `apps/api`: `routes/me.ts` (registrazione hub), `routes/shipments.ts` e
  `routes/shipment-lifecycle.ts` (`storageFitsHub`, `hoursFromNow` →
  `daysFromNow` sul calcolo di `storage_deadline_at`), `lib/parcel.ts`.
- `apps/web`: form Spedisci e form hub (input in giorni), scheda hub e
  dashboard (visualizzazione in giorni), i18n it/en delle nuove label.
- `docs`: ESCROW §4 e TOS §10 riscritti in giorni (numero invariato a 7);
  ARCHITECTURE §4/§5 dove citano `max_storage_hours`.

Parte 2 (cap 30 + bond rolling) — dopo la decisione §3: nuovo ADR
sull'escrow, timer di rinnovo, stato del rinnovo, evento di custodia, `MAX_
STORAGE_DAYS = 30`, TOS §10 a 30 giorni.

## Alternative considerate

- **Cap 1–7 in giorni e basta (l'opzione "Recommended" della domanda a
  Giacomo)**: consegna tutto il valore di leggibilità del punto 2 a rischio
  zero, e lascia i 30 giorni a quando servono davvero dei dati d'uso. Scartata
  come decisione *finale* su richiesta di Giacomo (vuole i 30), ma **è
  esattamente la Parte 1** qui sopra: la si adotta comunque come primo tempo.
- **Cap 30 subito, bond invariato**: la si è esclusa nel §Contesto — promette
  una finestra che l'hold del bond non regge. È il modo di rompere lo zero-
  custodia per una riga di UI.
- **Disaccoppiare la giacenza dal bond** (bond a durata fissa breve, giacenza
  lunga senza copertura oltre): lascerebbe il pacco senza un custode con bond
  attivo per la coda della giacenza, violando l'invariante «un solo custode con
  bond» (ARCHITECTURE §5 inv. 4). Scartata.

## Conseguenze

- Il mittente e l'hub ragionano in giorni ovunque; sparisce l'unico numero della
  UI che nessuno pensa nell'unità in cui è scritto.
- Il tetto resta **onesto**: la UI non offre mai una giacenza che il bond non può
  garantire. Finché la Parte 2 non atterra, il massimo resta 7 giorni — detto,
  non nascosto.
- La strada per i 30 giorni è tracciata e ha un costo chiaro (un meccanismo di
  rinnovo nell'escrow), separato dal resto del punto 2 così che la leggibilità
  non aspetti l'escrow.
- Nulla in questo ADR mette la piattaforma nel flusso di denaro: il rinnovo
  rolling è ancora una catena di hold dirette hub→mittente, coordinate per
  preimage (ADR-013 invariato).
