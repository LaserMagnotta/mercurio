# ADR-033 — Rinnovo rolling del bond dell'hub: la giacenza arriva a 30 giorni

- Stato: **accettato** — 2026-07-19 (attuazione della direzione già confermata
  da Giacomo in ADR-026 §3, opzione A).
- Contesto: ADR-026 (giacenza in giorni; Parte 2 «tetto a 30 con bond a
  rinnovo rolling» rimandata a una sessione dedicata — questa); ESCROW.md §2
  (default sicuro), §4 (budget CLTV, «rinnovo rolling del bond» come
  evoluzione); ADR-011 (timer come fatti su `shipment_timers`); ADR-013 (zero
  custodia); TOS.md §10 (svincolo di fine giacenza).

## Contesto

Il tetto di 7 giorni sulla giacenza non è mai stato una scelta di UI: è il
budget CLTV della **singola** hold invoice che vincola il bond dell'hub per
tutta la giacenza. Una HTLC che deve vivere 30 giorni (~4300 blocchi) viene
rifiutata da molti nodi di instradamento, congela la liquidità dell'hub per un
mese e alza il rischio di force-close. ADR-026 §3 ha scelto la strada (opzione
A): spezzare il bond in una **catena di hold a finestre corte**, rinnovata dal
coordinatore prima di ogni scadenza. Questo ADR fissa i parametri e il
comportamento di macchina a stati, executor e timer; con esso
`MAX_STORAGE_DAYS` sale a 30.

Un fatto dell'implementazione rende il rinnovo indolore: la creazione di un
conditional payment è già **interamente automatica** — il coordinatore fa
emettere la hold al wallet del beneficiario e la fa pagare al wallet del
pagatore (NWC/LND), senza alcuna azione umana (è così che l'hub di partenza
vincola il bond durante `origin_hub_accept`). «Rinnovare» è quindi: creare la
hold della finestra successiva, attendere che risulti `held`, annullare la
precedente. L'hub «non rinnova» solo se il suo wallet è spento, scollegato o
senza liquidità — cioè esattamente quando non può più garantire la custodia.

## Decisioni

### 1. Finestra di rinnovo: 7 giorni, con anticipo di 24 ore

- `BOND_RENEWAL_WINDOW_DAYS = 7`: ogni hold del bond copre al massimo 7
  giorni — lo stesso budget CLTV di oggi, che resta l'unico vincolo Lightning
  che il protocollo assume.
- `BOND_RENEWAL_LEAD_HOURS = 24`: il timer `bond_renewal` (nuovo kind su
  `shipment_timers`, ADR-011) scatta 24 ore **prima** della fine finestra.
  Lo sweep dei timer gira ogni minuto: un fallimento transitorio del wallet
  (riavvio, canale in re-connect) ha un giorno intero di retry prima che il
  mancato rinnovo diventi definitivo.
- La fine finestra corrente vive in `hub_stays.bond_window_ends_at`,
  aggiornata a ogni rinnovo; `NULL` marca gli stay pre-esistenti (creati con
  cap 7: non avranno mai bisogno di rinnovo, il timer eventualmente orfano
  muore da stale).

### 2. Il rinnovo è una transizione della macchina a stati

Nuovo evento `bond_renew` (armato dal timer, mai da un utente), legale negli
stati in cui esiste uno stay con bond vivo: `AWAITING_DROPOFF`, `AT_HUB`,
`LEG_BOOKED`, `AWAITING_PICKUP`, `CLAIMED`. Effetti del ramo di rinnovo:

1. `create_conditional_payment` (`custody_bond`, hub → mittente, stesso
   importo, stesso ref `hub_stay`) con **nonce di idempotenza** pari alla
   nuova fine finestra: ogni round di rinnovo ha la sua chiave, i retry dello
   stesso round riusano la stessa. L'executor attende che la nuova hold sia
   `held` prima di fare qualunque altra cosa (stessa via di
   `origin_hub_accept`): **mai un istante senza custode con bond** —
   l'invariante 4 di ARCHITECTURE §5 vale anche a metà rinnovo, perché la
   vecchia hold è ancora in volo finché la nuova non è osservata.
2. Solo allora `refund` della hold precedente.
3. Scritture ledger appaiate (`hub_bond_held` nuova, `hub_bond_refunded`
   vecchia): il commitment netto del bond resta identico attraverso il
   rinnovo (ADR-010).
4. Evento di catena di custodia `bond_renewed` (nuovo type) con importo e
   nuova fine finestra: la catena documenta ogni finestra, come chiede
   ADR-026 §3.
5. Riarmo del timer alla finestra successiva.

Un rinnovo **non necessario** (fine giacenza entro la finestra corrente, stay
già rilasciato, spedizione terminale) viene respinto dai guard e il timer
muore da stale — la regola di ADR-011: «i job sono promemoria, la verità è
nella macchina a stati».

### 3. Mancato rinnovo = fine giacenza anticipata (TOS §10)

Se la finestra si chiude senza che il rinnovo sia riuscito (`now ≥
bond_window_ends_at`), l'hub ha dichiarato coi fatti di non voler più
custodire (ADR-026 §3). Per stato:

- **`AT_HUB` / `AWAITING_PICKUP` / `CLAIMED`** — stessi effetti di
  `storage_expiry`: bond annullato, hold pendenti di leg/claim/richieste
  dissolte, `FORFEITED`, svincolo secondo TOS §10 (finestra di recupero e
  tariffa extra invariate). L'evento di catena è `expired` con
  `reason: 'bond_renewal'`; il mittente riceve una mail dedicata
  (`hub_bond_lapsed`) perché — a differenza della scadenza di giacenza — non
  ci sono stati preavvisi 72/24 h.
- **`AWAITING_DROPOFF`** — il pacco è ancora dal mittente: la prenotazione
  si dissolve a costo zero (`CANCELLED`, bond annullato, mail al mittente).
  Nessuno svincolo: non c'è nulla da svincolare.
- **`LEG_BOOKED`** — un vettore ha già i fondi vincolati e il ritiro è
  questione di ore (finestra pickup 24 h): forfeit qui punirebbe vettore e
  mittente per una colpa dell'hub. La macchina **continua a tentare il
  rinnovo** a ogni sweep; il caso si risolve da solo col check-out (bond
  rilasciato) o col pickup_timeout (si torna in `AT_HUB`, dove la regola
  sopra riprende). La finestra di sforamento possibile è limitata dalla
  finestra di pickup ed è accettata — documentata qui, non nascosta.

### 4. Chi arma i timer, e quando

- `origin_hub_accept`: il bond origine nasce `held` → timer armato subito
  (`AWAITING_DROPOFF` non ha scadenza propria e può superare i 7 giorni).
- `deposit_accept`: la finestra del bond d'arrivo parte ora (prudenziale:
  la hold è pagata entro l'ora del funding), ma **niente timer**: tra accept
  e check-in passano al massimo funding (1 h) + pickup (24 h) + transito
  (48 h) ≪ 7 giorni, e ogni esito negativo del leg annulla il bond.
- `leg_checkin`: lo stay d'arrivo diventa attivo → timer armato sulla
  finestra memorizzata all'accept.
- `leg_return`: bond fresco del hub di ritorno → finestra nuova, timer.
- Rilasci e chiusure (`pickup_checkout`, `recipient_pickup`,
  `recipient_claimed_pickup`, `storage_expiry`, `cancel`) disarmano il timer
  insieme al bond che muore.

### 5. Il tetto sale a 30 giorni

`MAX_STORAGE_DAYS = 30` (ADR-026 Parte 2): costante, validazioni API
(creazione spedizione e registrazione hub), form web, TOS §10 («fino a 30
giorni»). Nessuna migrazione d'unità: la colonna è già in giorni. La
finestra di recupero post-svincolo e la tariffa extra di TOS §10 restano
invariate (7 giorni, 1,50 €/giorno).

## Limite noto: le hold Π_h e di claim non rinnovano (ancora)

Con la giacenza a 30 giorni il bond dell'hub non è più il lock più lungo
possibile: la hold del premio `Π_h` (ADR-014, mittente → hub di destinazione,
in volo dal funding della tratta finale al ritiro) e le hold di un claim
prenotato (ADR-016) possono restare in volo quanto la giacenza a
destinazione. Questo ADR **non** estende loro il rinnovo rolling. La scelta è
deliberata:

- gli importi sono piccoli (la `Π_h` è il 3% dell'offerta) e la degradazione
  è **senza perdita**: una hold che scade oltre la sua finestra viene marcata
  `expired` dal coordinatore con la scrittura ledger di rimborso, il
  commitment torna al mittente e il ritiro procede semplicemente senza
  premio (il context builder filtra `created|held`, quindi
  `recipient_pickup` salta il bonus);
- il claimant di un claim ha i **propri** fondi vincolati nella hold: il suo
  incentivo a ritirare in fretta è già massimo;
- il meccanismo di rinnovo qui introdotto (nonce di idempotenza, evento di
  catena, timer per ref) generalizza a quelle hold quando i dati d'uso
  mostreranno che serve.

## Alternative considerate

- **HTLC singola lunga (opzione B di ADR-026)** e **ri-bond manuale a
  checkpoint (opzione C)**: già scartate in ADR-026 §3, decisione di Giacomo.
- **Forfeit anche in `LEG_BOOKED`**: scartato — richiederebbe una semantica
  nuova (slash del leg a colpa dell'hub) per un caso che le finestre attuali
  rendono quasi impossibile e che si risolve da solo in ≤24 h.
- **Timer armato anche a `deposit_accept`**: scartato — sarebbe sempre stale
  o ridondante rispetto al riarmo del check-in; meno righe morte in tabella.
- **Rinnovo con anticipo maggiore (es. 48 h)**: più margine di retry ma più
  sovrapposizione di liquidità (due hold in volo durante il rinnovo); 24 h
  bastano con sweep al minuto.

## Conseguenze

- La giacenza scelta dal mittente arriva a 30 giorni **senza** HTLC lunghe:
  ogni hold resta nel budget CLTV di 7 giorni; la generalizzazione oltre i 30
  è solo una costante, il meccanismo non cambia.
- Durante ogni rinnovo l'hub ha per qualche secondo due hold in volo (la
  vecchia e la nuova): il picco di liquidità impegnata è 2× bond, dichiarato
  qui — è il prezzo del «mai senza custode con bond».
- Lo zero-custodia è invariato (ADR-013): ogni finestra è ancora un vincolo
  diretto hub → mittente coordinato per preimage; la piattaforma continua a
  non poter dirottare nulla. Se la piattaforma sparisce a metà catena, la
  hold corrente scade e i fondi tornano all'hub — default sicuro (ESCROW §2).
- Un hub col wallet instabile scoprirà i propri limiti: ogni mancato rinnovo
  è documentato nella catena di custodia e sfocia in uno svincolo anticipato
  con mail al mittente. È il comportamento onesto: meglio un forfeit
  esplicito che una custodia non garantita.
