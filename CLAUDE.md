# Mercurio — rete logistica peer-to-peer

## Visione

Mercurio collega chi deve spedire pacchi di basso valore e senza urgenza con
vettori occasionali e hub diffusi (negozi, bar) che fanno da punti di deposito.
I pagamenti avvengono su Lightning Network con pagamenti condizionali diretti tra
utenti, **senza che la piattaforma custodisca mai fondi**; ogni parte impegna un
bond che viene liberato quando fa la sua parte. Tutto open source.

## I tre ruoli (uno stesso account può averli tutti)

- **Mittente**: crea la spedizione e porta il pacco all'hub di partenza.
- **Vettore**: sceglie spedizioni dalla bacheca e le trasporta tra hub,
  anche solo per una tratta parziale.
- **Hub**: attività con orari lunghi che custodisce pacchi in transito
  in cambio di una percentuale.

## Flusso di riferimento (esempio canonico)

1. Marco deve spedire penne (valore 10 €) dalla città A alla città B (100 km).
   Nella sezione "Spedisci" compila: hub di partenza e di destinazione, tempo
   massimo di giacenza in hub (scaduto il quale il pacco diventa svincolabile
   secondo i ToS a favore dell'hub), email del
   destinatario, dimensioni, peso, contenuto (dichiararlo è opzionale), foto
   opzionali (del contenuto e/o del pacco sigillato), offerta per la spedizione
   (es. 5 €) e bond richiesto al vettore (es. 15 €).
2. Riceve un QR da stampare e applicare sul pacco: inquadrato, identifica la
   spedizione su Mercurio.
3. Porta il pacco all'hub della città A gestito da Mario, che ha accettato in
   anticipo e ha bloccato anche lui un bond (liberato quando un vettore ritira
   il pacco).
4. Luca (vettore) apre la bacheca del suo hub, vede la spedizione a 5 € verso B,
   accetta, blocca il suo bond nell'escrow e ritira il pacco da Mario.
5. Luca non arriva fino a B: lascia il pacco in un hub della città C (a 60 km
   da B) che aveva accettato quando il pacco è partito dal primo hub. Se il
   pacco è integro e consegnato, il bond di Luca si sblocca e lui incassa il
   lordo della sua tratta, proporzionale ai km di avvicinamento sul **pool di
   lavoro** (il 90% dell'offerta — il 10% è il premio di finalizzazione del
   punto 7): 4,50 € × 40/100 = 1,80 €; da quel lordo l'hub di partenza (Mario)
   e l'hub di arrivo trattengono la propria percentuale (10% ciascuno ⇒
   0,18 € + 0,18 €), a Luca restano 1,44 €. Le percentuali degli hub sono
   configurabili da ciascun hub e si applicano al lordo di ogni tratta
   (dettagli in /docs/ECONOMICS.md).
6. Marco e il destinatario ricevono una mail: il pacco è in C. Si attende un
   nuovo vettore per la tratta successiva, finché il pacco arriva a destinazione.
7. A destinazione il destinatario riceve una mail e ritira gratis all'hub;
   al ritiro il mittente riceve la conferma. Chi conclude il percorso incassa
   il **premio di finalizzazione** (10% dell'offerta, ADR-014): 70% al vettore
   che consegna all'hub di destinazione, 30% all'hub di destinazione al
   momento del ritiro.

## Hub — dettagli

Registrazione con: indirizzo, orari di apertura, dimensioni e peso massimi
accettati, se accetta pacchi con contenuto non dichiarato, percentuale
richiesta, tempo massimo di stoccaggio. Dashboard con le richieste di
deposito: destinazione, percentuale che riceverebbe, bond da bloccare,
tempo massimo di stoccaggio.

## Vettore — viaggio e matching

Prima di consultare la bacheca, il vettore dichiara il proprio viaggio
reale: destinazione, deviazione massima in km che è disposto a fare e
tariffa minima in €/km di deviazione. Per la tariffa il sistema propone
un valore fattibile, calcolato come media al ribasso di ciò che i vettori
hanno effettivamente accettato (default sensato finché non ci sono dati).
Nella bacheca dell'hub, le spedizioni che soddisfano i suoi criteri
compaiono per prime ed evidenziate; le altre restano visibili sotto.

## Pagamenti

Tutti su Lightning Network, diretti tra gli utenti e protetti da pagamenti
condizionali (hold invoice) coordinati per preimage: la piattaforma non
custodisce mai fondi (la scelta tecnica è in /docs/ESCROW.md). Bond per hub e
vettori. Ogni movimento è registrato in un ledger contabile a partita doppia.

## Recensioni

Sistema a 5 stelle separato per ruolo: si può essere un ottimo vettore e un
pessimo hub. Rating e numero recensioni visibili ovunque si scelga una
controparte.

## Requisiti non funzionali

- Open source su GitHub, licenza MIT.
- Codice e commenti in inglese, ben commentati (spiegare il PERCHÉ delle
  scelte); UI in italiano con i18n pronto per l'inglese.
- Conformità privacy (GDPR): minimizzazione dati, consenso, export e
  cancellazione dei propri dati.
- UI/UX secondo la Bitcoin Design Guide: https://bitcoin.design/guide/
  (importi in sats mai ambigui, pattern di pagamento del reference design
  "Daily spending wallet", accessibilità).
- L'app mobile arriverà in seguito: il web è mobile-first e le API sono
  pubbliche e documentate.

## Regole per Claude Code

- Leggi /docs prima di ogni task; se manca una decisione, proponila e
  aggiorna /docs.
- Nessuna logica di denaro senza test; ogni movimento passa dal ledger.
- Commit piccoli con conventional commits; mai segreti nel repo.
- Se la specifica è ambigua, chiedi invece di inventare.
