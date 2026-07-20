# Mercurio — Termini di servizio

> **Versione 2026-07-17** — testo di progetto. Ogni clausola che promette un
> comportamento del software cita l'evento della macchina a stati che lo
> implementa (tabella in [ARCHITECTURE.md §5](../ARCHITECTURE.md)); le
> decisioni a monte sono in [RISKS.md](../RISKS.md) §1–§6 e negli ADR citati.
> Il testo è pensato per essere pubblicato così com'è nella pagina `/tos` di
> ogni istanza; l'unico campo da compilare al deploy è l'identità del Gestore
> (§1). Revisione da parte di un legale: todo umano, tracciato in RISKS §8.

## 1. Che cos'è Mercurio, chi è il Gestore

Mercurio è un software open source (licenza MIT) che coordina una rete
logistica peer-to-peer: chi deve spedire un pacco (**mittente**) lo affida a
punti di deposito diffusi (**hub**) e a viaggiatori occasionali (**vettori**),
che lo avvicinano alla destinazione tratta per tratta. I pagamenti avvengono
su Lightning Network direttamente tra gli utenti.

Il **Gestore** è il soggetto che opera questa istanza di Mercurio ed è
identificato nella pagina `/tos` dell'istanza. Il Gestore mette a
disposizione il software di coordinamento; **non è parte dei contratti tra
gli utenti** (§3), **non custodisce mai fondi** (§5), **non decide
controversie** (§7). Il servizio di coordinamento è gratuito: la fee di
piattaforma è 0% (RISKS §8, decisione 6).

## 2. Ruoli e definizioni

- **Mittente**: crea la spedizione, sigilla il pacco e lo consegna all'hub di
  partenza. Uno stesso account può avere tutti i ruoli.
- **Hub**: attività con orari lunghi che custodisce pacchi in transito in
  cambio di una percentuale, configurata nel proprio profilo, sul lordo di
  ogni tratta adiacente (ECONOMICS.md).
- **Vettore**: sceglie spedizioni dalla bacheca e le trasporta tra hub, anche
  solo per una tratta parziale.
- **Destinatario**: riceve gli aggiornamenti via email e ritira il pacco a
  destinazione (gratis, senza bisogno di account); con un account e un wallet
  può inoltre **ritirare in anticipo** il pacco da un hub del percorso
  (*claim*, §9).
- **Catena di custodia**: il registro append-only, con hash concatenati, di
  ogni evento della spedizione. È la prova documentale di chi ha certificato
  cosa, e questi Termini vi fanno rinvio per ogni esito.
- **Bond di custodia**: l'importo, fissato dal mittente, che chiunque prenda
  in custodia il pacco (hub o vettore) vincola come garanzia (§5).

## 3. Il contratto è tra pari; la piattaforma non è parte

Ogni spedizione dà luogo a un **contratto atipico di logistica tra privati**,
concluso direttamente tra mittente, hub e vettori che accettano di prenderne
parte: l'accettazione dell'hub (`origin_hub_accept`), l'accettazione della
tratta da parte del vettore (`leg_accept`) e ogni certificazione ai passaggi
di mano sono le manifestazioni di volontà delle parti, registrate nella
catena di custodia. La custodia del pacco presso un hub è un **deposito
oneroso** (artt. 1766 ss. c.c.) accessorio a quel contratto (RISKS §4).

Il Gestore non assume obbligazioni di trasporto, deposito o consegna; non
seleziona né controlla preventivamente pacchi, utenti od offerte; non
garantisce che una spedizione trovi vettori o arrivi a destinazione. Le
uniche obbligazioni del Gestore sono quelle del §12 (funzionamento del
software di coordinamento) e quelle dell'informativa privacy.

## 4. Requisiti di accesso

- **Maggiore età**: il servizio è riservato a chi ha compiuto 18 anni.
- **Email verificata** (magic link): è il canale operativo delle notifiche.
- **Wallet Lightning proprio**, con supporto alle hold invoice, per chi
  muove denaro (mittente, vettore, hub, destinatario che fa un claim): la
  piattaforma verifica le capacità del wallet al collegamento e non ha
  accesso ai fondi (§5).
- Su Lightning chi paga e chi incassa devono essere utenti diversi: mittente,
  vettore della tratta e proprietari degli hub coinvolti in una stessa
  spedizione devono essere account distinti (il sistema rifiuta l'operazione
  con `self_payment_impossible`).

L'accettazione di questi Termini e dell'informativa privacy avviene alla
creazione dell'account ed è registrata con data e versione
(tabella `consent_events`).

## 5. Pagamenti, bond, zero custodia (ADR-013)

1. **La piattaforma non custodisce mai fondi.** Ogni vincolo economico —
   pagamento di tratta, bond del vettore, bond dell'hub, pagamento di claim —
   è una **hold invoice direttamente tra i due utenti interessati**; le fee
   degli hub sono pagamenti istantanei diretti al passaggio di mano. La
   piattaforma detiene soltanto le preimage (informazione che sblocca un
   pagamento già vincolato verso un beneficiario fissato ex ante), mai
   denaro. Se l'istanza cessa di funzionare, ogni hold scade e i fondi
   tornano automaticamente ai pagatori (**default sicuro**).
2. **L'offerta è un impegno di spesa**, non un fondo prefinanziato: si paga
   tratta per tratta (`leg_funded`, riga 5 della tabella di ARCHITECTURE §5).
   Il 90% dell'offerta è il **pool di lavoro**, ripartito in proporzione ai
   km di avvicinamento; il 10% è il **premio di finalizzazione** (70% al
   vettore che consegna a destinazione, 30% all'hub di destinazione al
   ritiro — ADR-014). Gli importi di ogni tratta sono calcolati e **congelati
   all'accettazione**: nessuna rinegoziazione.
3. **Bond di custodia**: chi prende in custodia il pacco vincola il bond
   fissato dal mittente (hub a `origin_hub_accept`, riga 2; vettore a
   `leg_funded`, riga 5; hub d'arrivo idem). Il bond si sblocca quando la
   custodia passa con certificazione (`pickup_checkout` riga 6, `leg_checkin`
   righe 8–9, `recipient_pickup` riga 11) e viene **incassato dal mittente**
   solo negli esiti deterministici del §8. Tetto del bond: **1.000 €**
   (equivalente in sats al cambio congelato; `bond_above_cap`).
4. **Importi in satoshi**: ogni importo è espresso e regolato in sats/msat;
   l'euro è solo indicativo, al **cambio congelato alla creazione** della
   spedizione (ADR-008). Chi incassa sats accetta il rischio di cambio.
5. Ogni movimento è registrato in un **ledger a partita doppia** (ADR-010) e
   riconciliato con lo stato reale delle invoice nei wallet degli utenti.

## 6. Contenuti: autodichiarazione, esclusioni, tetto di valore

1. **Il mittente autodichiara la liceità del contenuto e ne resta l'unico
   responsabile.** Hub e vettori sono meri detentori in buona fede: prendono
   in custodia un pacco sigillato sulla base delle dichiarazioni del mittente
   e possono **sempre rifiutarlo** (§7), senza penalità.
2. **Merci escluse.** È vietato spedire: armi, munizioni ed esplosivi;
   sostanze stupefacenti o psicotrope; farmaci; tabacco e prodotti soggetti
   ad accisa; denaro contante, titoli al portatore, carte prepagate e valori;
   animali vivi; materiali pericolosi, infiammabili o corrosivi, incluse
   batterie al litio non installate o non protette; merce contraffatta o di
   provenienza illecita; qualunque bene la cui spedizione tra privati sia
   vietata dalla legge. I beni deperibili sono ammessi ma viaggiano a
   esclusivo rischio del mittente (per essi lo smaltimento a fine giacenza è
   ammesso, §10).
3. **Tetto di valore: 45 €.** Il valore del contenuto non può eccedere 45 €
   (soglia allineata alla franchigia doganale UE per le spedizioni
   occasionali tra privati — Reg. (CE) 1186/2009, artt. 25-27; Dir.
   2006/79/CE). Il tetto vale anche come criterio oggettivo di stima nello
   svincolo di fine giacenza (§10). Il tetto di valore **non è un tetto di
   cura**: il bond richiesto può arrivare a 1.000 € (§5.3).
4. **Contenuto non dichiarato**: dichiarare il contenuto è facoltativo, ma i
   pacchi non dichiarati raggiungono solo gli hub che hanno fatto opt-in
   esplicito nel proprio profilo (`accepts_undeclared`) e sono segnalati in
   bacheca ai vettori prima dell'accettazione.
5. La piattaforma non esercita alcuna sorveglianza generale sui contenuti
   intermediati (coerentemente con il Reg. (UE) 2022/2065 — DSA); non esiste
   un canale di segnalazione interno al prodotto. Il presidio è il diritto di
   rifiuto documentato (§7) e la tracciabilità della catena di custodia.

## 7. Passaggi di mano: accettare o rifiutare, mai giudicare (ADR-012)

1. A ogni passaggio di mano chi riceve il pacco ha due sole mosse:
   **accettare** — certifica con foto l'integrità; la custodia passa e bond e
   payout del custode precedente si sbloccano definitivamente — o
   **rifiutare** (`handoff_reject`, riga 12: foto + motivo; la custodia NON
   passa, lo stato non cambia, nessun movimento di denaro; il mittente è
   notificato).
2. **La responsabilità segue la custodia certificata**: chi accetta senza
   ispezionare si assume il rischio. Dal momento della certificazione ogni
   danno scoperto dopo è attribuito al custode corrente, il cui bond è
   l'unica garanzia in gioco.
3. Il rifiuto è gratuito e non comporta penalità; è registrato nella catena
   di custodia e, se sistematico e immotivato, pesa sulla reputazione (§11).
4. Il mittente può documentare lo stato iniziale con **foto facoltative del
   contenuto e del pacco sigillato** alla creazione (certificate dall'evento
   `created` — ADR-022): sono la sua principale tutela documentale.

## 8. Esiti deterministici: nessun arbitro, nessuna disputa (ADR-012)

**Non esiste un arbitro né uno stato di disputa.** Il denaro si muove solo
per regole meccaniche, ciascuna implementata da una transizione della
macchina a stati (tabella in ARCHITECTURE §5):

| Fatto | Transizione | Esito economico |
| --- | --- | --- |
| Consegna certificata dall'hub ricevente | `leg_checkin` (righe 8–9) | il vettore incassa il lordo della tratta direttamente dal mittente; il suo bond si sblocca |
| Il vettore non ritira entro 24 h dal funding | `pickup_timeout` (riga 7) | il bond del vettore è incassato dal mittente; pagamento tratta annullato; il pacco torna in bacheca |
| Il vettore non consegna entro 48 h dal ritiro | `transit_timeout` (riga 14) | il bond del vettore è incassato dal mittente; pagamento tratta annullato; spedizione `LOST` |
| Il vettore riporta il pacco all'hub di partenza della tratta | `leg_return` (riga 10) | pagamento e bond annullati, nessun payout; l'hub cedente **è tenuto a riaccettare** ciò che ha certificato al check-out |
| Giacenza scaduta | `storage_expiry` (riga 13) | pacco svincolato all'hub secondo il §10; bond dell'hub annullato |
| Ritiro del destinatario | `recipient_pickup` (riga 11) / `recipient_claimed_pickup` (riga 21) | accettazione definitiva; premio di finalizzazione regolato; spedizione chiusa |

Conseguenze accettate da tutte le parti con questi Termini:

- **Nei casi non provabili** — un danno emerso dove nessuna regola meccanica
  individua un responsabile — **nessuno viene risarcito**: la perdita resta
  al mittente e la reputazione registra i comportamenti (§11).
- **Non esiste alcuna assicurazione sul trasporto**: il bond di custodia,
  dimensionato dal mittente, è l'unica garanzia peer-to-peer.
- Le fee hub già pagate ai passaggi di mano fisici restano pagate: retribuiscono
  un servizio già reso e non sono soggette a clawback.

## 9. Ritiro, accettazione definitiva, ritiro anticipato

1. **Il ritiro è l'accettazione definitiva.** A destinazione il destinatario
   ispeziona il pacco e poi digita l'OTP ricevuto via email: la spedizione si
   chiude lì (`recipient_pickup`, riga 11). **Non esiste una finestra di
   contestazione** dopo il ritiro; prima di digitare il codice, il
   destinatario può rifiutare il passaggio come chiunque altro (§7).
2. **Ritiro anticipato (claim, ADR-016)**: con il codice personale ricevuto
   nella mail di tracking, il destinatario titolare di account con wallet può
   reclamare il pacco fermo in un hub del percorso (`recipient_claim`,
   riga 18), incassando il pool residuo e la quota vettore del premio: sta
   facendo lui l'ultima tratta. Il ritiro fisico (`recipient_claimed_pickup`,
   riga 21) è accettazione definitiva come l'OTP. Il codice personale è una
   credenziale al portatore: chi lo riceve è tenuto a non condividerlo.
3. Il claim non sospende la giacenza (§10): se la giacenza scade con un claim
   pendente o attivo, le hold del claim vengono annullate e il pacco è
   svincolato (`storage_expiry`, riga 13).

## 10. Fine giacenza: svincolo a favore dell'hub

Il mittente sceglie alla creazione il tempo massimo di giacenza per hub
(fino a 30 giorni); il sistema rifiuta gli hub il cui limite è più corto
(`hub_storage_too_short`): la finestra scelta dal mittente non è mai
ristretta in silenzio. La scadenza corrente è sempre visibile nelle pagine
della spedizione e del tracking. Alla scadenza il bene stesso compensa l'hub
per lo stoccaggio: con l'architettura senza custodia non esiste un fondo da
girargli (ADR-013). Lo svincolo opera in **cascata**, e ogni fase interna al
software cita la sua implementazione:

1. **Preavvisi**: mittente e destinatario ricevono un'email di preavviso a
   72 e a 24 ore dalla scadenza della giacenza (worker `storage-warnings`,
   sul timer `storage` armato dal check-in). Fino alla scadenza il mittente
   può sempre: far ripartire il pacco (`boost`, riga 15), cambiarne la
   destinazione o **richiamarlo verso l'origine** indicando se stesso come
   destinatario (`reroute`, riga 16), o annullare la spedizione se nessun
   vettore l'ha ancora ritirata (`cancel`, riga 17).
2. **Scadenza**: la transizione `storage_expiry` (riga 13) porta la
   spedizione nello stato `FORFEITED`, annulla il bond dell'hub e le
   eventuali hold di un claim pendente. Qui **termina il coordinamento della
   piattaforma**: le fasi successive sono obbligazioni dirette tra hub e
   mittente, regolate da questi Termini e adempiute fuori dal software.
   Il vincolo di custodia (bond) dell'hub è rinnovato automaticamente a
   finestre di 7 giorni per coprire giacenze più lunghe (ADR-033); il
   **mancato rinnovo** da parte dell'hub produce, in anticipo, lo stesso
   esito della scadenza (`bond_renew`, ramo di mancato rinnovo): la giacenza
   termina in quel momento, il mittente è avvisato via email e si applicano
   la stessa finestra di recupero e la stessa tariffa dei punti 3 e 4. Se il
   pacco non è ancora stato consegnato all'hub, la prenotazione si dissolve
   senza alcun costo e senza svincolo.
3. **Finestra di recupero — 7 giorni**: per 7 giorni di calendario dalla
   scadenza il mittente (o un suo incaricato) può ancora ritirare il pacco
   presso l'hub, pagando direttamente all'hub la giacenza extra maturata
   alla tariffa del punto 4. L'hub è tenuto a consegnarglielo contro
   pagamento.
4. **Tariffa di giacenza extra**: 1/30 del tetto di valore per ogni giorno
   iniziato oltre la scadenza, cioè **1,50 € al giorno** (pagabile in sats al
   cambio corrente o in contanti, direttamente all'hub). La tariffa è unica,
   fissata qui ex ante per tutte le istanze e tutte le parti.
5. **Svincolo in forma marciana**: decorsa la finestra di recupero, l'hub può
   trattenere o realizzare il bene a compensazione del credito di giacenza
   extra maturato. La stima del bene è ancorata a un criterio oggettivo
   fissato ex ante: **il tetto di valore dichiarabile (45 €, §6.3)**. Se il
   valore così stimato eccede il credito maturato, **l'eccedenza è
   riconosciuta al mittente** (è la forma marciana che supera il divieto di
   patto commissorio, art. 2744 c.c. — cfr. Cass. 1625/2015 e artt. 48-bis,
   120-quinquiesdecies TUB). In alternativa l'hub può optare per la
   **donazione documentata a un ente benefico**, che estingue le pretese
   reciproche. Lo **smaltimento** è ammesso solo per beni deperibili o di
   valore nullo, con motivazione registrata.

La clausola riprende facoltà che l'ordinamento già riconosce a chi custodisce
o trasporta (artt. 1686, 1690, 2756, 2796-2797 c.c.), con tutele aggiuntive:
preavvisi, finestra di recupero, richiamo sempre disponibile prima della
scadenza, tariffa pubblicata ex ante, tetto di stima ed eccedenza al
mittente. Questa clausola è approvata specificamente ai sensi degli
artt. 1341-1342 c.c. (§15).

## 11. Recensioni (ADR-017)

A spedizione chiusa — in qualunque stato terminale: `DELIVERED`, `CANCELLED`,
`FORFEITED`, `LOST` — ogni partecipante effettivo può recensire ogni altro
partecipante effettivo, nel ruolo che ha davvero avuto, entro **30 giorni**
dalla chiusura. Il rating è separato per ruolo (mittente, vettore, hub); le
recensioni sono pubbliche, non modificabili e non cancellabili: sono un
giudizio datato, come un evento di custodia. In un sistema senza arbitri la
reputazione è la sanzione: chi pubblica una recensione si assume la
responsabilità di ciò che scrive; sono vietati contenuti diffamatori o dati
personali di terzi nel testo.

## 12. Obblighi e responsabilità del Gestore

1. Il software è fornito **"così com'è"**, senza garanzia di disponibilità
   continuativa (licenza MIT). Il Gestore non risponde delle obbligazioni
   degli utenti tra loro (trasporto, custodia, consegna, pagamenti), né dei
   danni da caso fortuito, forza maggiore o uso improprio del servizio.
2. Il Gestore non ha alcun potere discrezionale sui movimenti di denaro:
   ogni movimento è deciso dalle regole di questi Termini ed eseguito dal
   software (ADR-012, ADR-013). L'architettura garantisce che anche in caso
   di compromissione o cessazione dell'istanza i fondi vincolati tornino ai
   pagatori o vadano ai beneficiari già fissati (§5.1).
3. Nulla in questi Termini esclude o limita la responsabilità del Gestore nei
   casi in cui la legge non ne consente l'esclusione (art. 1229 c.c.; verso i
   consumatori, d.lgs. 206/2005).
4. Il Gestore può sospendere account che violano il §6 (merci escluse) o
   usano il servizio per attività illecite; la sospensione non tocca mai i
   fondi vincolati, che seguono comunque gli esiti del §8 (il Gestore non
   potrebbe toccarli nemmeno volendo).

## 13. Dati personali

Il trattamento dei dati personali è descritto nell'**informativa privacy**
([PRIVACY.md](PRIVACY.md), pagina `/privacy` dell'istanza), che copre anche
la posizione del destinatario indicato dal mittente. La catena di custodia e
il ledger non contengono dati personali e sopravvivono alla cancellazione
dell'account (anonimizzazione, art. 17 GDPR).

## 14. Modifiche, legge applicabile, foro

1. Il Gestore può aggiornare questi Termini; le modifiche si applicano dalle
   nuove adesioni e, per gli account esistenti, dopo notifica via email con
   30 giorni di preavviso. Le spedizioni in corso restano regolate dalla
   versione accettata alla loro creazione.
2. Questi Termini sono regolati dalla **legge italiana**.
3. Per gli utenti consumatori è competente il foro del luogo di residenza o
   domicilio del consumatore (d.lgs. 206/2005); per gli altri utenti, il foro
   della sede del Gestore.

## 15. Clausole approvate specificamente (artt. 1341-1342 c.c.)

Ai sensi degli artt. 1341 e 1342 c.c., l'utente approva specificamente le
seguenti clausole: §3 (estraneità del Gestore ai contratti tra utenti);
§7.2 (la responsabilità segue la custodia certificata); §8 (esiti
deterministici, assenza di arbitro e di risarcimento nei casi non provabili,
assenza di assicurazione); §9.1 (ritiro come accettazione definitiva, nessuna
finestra di contestazione); §10 (svincolo del pacco a fine giacenza, tariffa
di giacenza extra, stima e realizzo in forma marciana); §12 (limitazioni di
responsabilità del Gestore); §14 (modifiche e foro).

L'approvazione avviene con la spunta dedicata alla creazione dell'account,
distinta dall'accettazione generale, ed è registrata con data e versione.
