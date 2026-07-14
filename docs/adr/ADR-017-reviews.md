# ADR-017 — Recensioni: ruoli effettivi, stati ammessi, finestra temporale

- Stato: accettato — 2026-07-14; **implementato** lo stesso giorno
- Contesto: CLAUDE.md "Recensioni", [ARCHITECTURE.md](../ARCHITECTURE.md) §4
  (tabella `reviews`), [RISKS.md](../RISKS.md) §1 e §7 (la reputazione è
  l'unica sanzione in un sistema senza arbitri)
- Implementazione: `apps/api` (rotte, aggregati, superfici), schema già in
  migrazione 0000 — nessun movimento di denaro, ledger ed escrow non toccati

## Contesto

Lo schema `reviews` esiste dalla prima migrazione (5 stelle per ruolo,
unique su `(shipment, author, subject, role)`), ma senza rotte né regole:
chi può recensire chi, su quali spedizioni, entro quando. Il CLAUDE.md fissa
due principi — rating **separato per ruolo** ("si può essere un ottimo
vettore e un pessimo hub") e "si recensisce **solo chi ha avuto un ruolo
effettivo** nella spedizione" — ma lascia aperti tre punti: gli stati
terminali diversi da `DELIVERED`, il claimant dell'ADR-016 e la finestra
temporale. Questo ADR li chiude.

## Decisione

1. **Solo spedizioni chiuse, ma TUTTE le chiusure.** Si recensisce in ogni
   stato terminale — `DELIVERED`, `CANCELLED`, `FORFEITED`, `LOST` — non
   solo a consegna riuscita. Razionale: senza arbitri la reputazione è
   l'unica sanzione (ADR-012, RISKS §1) e i finali cattivi sono esattamente
   dove serve: il vettore che sparisce col pacco (`LOST`) o che non si
   presenta al ritiro va potuto recensire. A spedizione aperta niente
   recensioni: il giudizio arriva a esito noto, mai come leva negoziale
   durante il trasporto.
2. **Ruolo effettivo = impegno certificato o finanziato.** Chi è
   recensibile, e in quale ruolo:
   - il **mittente** sempre (`sender`): la spedizione è il suo atto;
   - il **vettore** di ogni tratta **finanziata** (`carrier`): la tratta ha
     raggiunto `LEG_BOOKED` — bond impegnato — qualunque cosa sia successa
     dopo, incluso `failed` (pickup/transit timeout: proprio il
     comportamento che la reputazione deve registrare). Una tratta
     `pending_funding`/`expired` non è mai esistita: l'accettazione si è
     dissolta da sola nella finestra di funding, nessuna interazione;
   - il **proprietario dell'hub** di ogni giacenza con **check-in
     certificato** (`hub`): l'hub ha davvero custodito il pacco. Una
     prenotazione mai attivata (hub d'arrivo di una tratta fallita, hub
     origine di una spedizione annullata prima della consegna fisica) non è
     un ruolo;
   - il **claimant** il cui claim ha raggiunto `CLAIMED` (ADR-016), come
     `carrier`: sta facendo lui la tratta residua — è la qualifica che
     l'ADR-016 stesso gli dà — e il claim non ritirato (`FORFEITED`) è un
     comportamento da registrare sul suo rating di vettore. Un claim mai
     finanziato rispecchia la tratta mai finanziata: nessun ruolo. Il
     destinatario del ritiro OTP ordinario resta fuori: può non avere
     nemmeno un account.
3. **Autori = lo stesso insieme.** Può scrivere recensioni solo un
   partecipante effettivo (in qualunque ruolo); può recensire ogni altro
   partecipante effettivo nel ruolo che quello ha davvero avuto. Nessun
   vincolo di interazione pairwise (il vettore della tratta 1 può recensire
   il vettore della tratta 2: hanno condiviso la stessa spedizione e il
   CLAUDE.md vincola sul ruolo nella spedizione, non sull'incontro).
   Niente auto-recensioni; una sola recensione per
   `(spedizione, autore, soggetto, ruolo)` — vincolo unique già a schema.
4. **Finestra: chiusura + 30 giorni** (`REVIEW_WINDOW_DAYS`). Datata
   dall'ultimo evento della catena di custodia (l'evento terminale).
   Allineata alla retention delle foto (chiusura + 30 giorni, RISKS §6): la
   documentazione e il giudizio su una spedizione condividono il ciclo di
   vita. Dopo, il ricordo sbiadisce e il canale resta aperto solo a
   ritorsioni fredde.
5. **Aggregati sempre calcolati dal DB in lettura** (media + numero per
   `(utente, ruolo)`), mai denormalizzati: stesso principio del ledger,
   niente saldi stantii. Esposti ovunque si scelga una controparte: card
   della bacheca (rating del mittente, dell'hub corrente e di ogni hub di
   consegna proposto), lista hub, dettaglio spedizione (tutti i
   partecipanti effettivi), `GET /users/:id/reviews` per la futura pagina
   profilo (pubblica: i rating sono informazione di mercato).
6. **Niente modifica né cancellazione** nell'MVP: una recensione è un
   giudizio datato, come un evento di custodia. La cancellazione GDPR
   dell'account anonimizza l'utente, non riscrive la storia (le recensioni
   restano agganciate all'id anonimizzato; export già comprensivo di
   scritte e ricevute).

## Alternative considerate

- **Solo `DELIVERED` recensibile**: lascerebbe senza voce proprio i casi in
  cui la reputazione è l'unico rimedio (RISKS §1 "la reputazione punisce i
  recidivi"). Scartata.
- **Vettore recensibile anche a tratta mai finanziata**: l'accettazione non
  finanziata scade da sola e non tocca nessuno; renderla recensibile
  aprirebbe a recensioni tra sconosciuti di fatto. Il pattern "accetta e
  non finanzia mai" è comunque tracciato (righe `legs`, catena di
  custodia). Scartata.
- **Claimant come ruolo dedicato (`recipient`)**: nuovo valore dell'enum e
  quarta media ovunque, per un attore che l'ADR-016 definisce "il vettore
  più motivato della rete" che fa la tratta residua. `carrier` è la
  semantica giusta e il rating resta confrontabile. Scartata.
- **Nessuna finestra temporale**: recensioni a mesi di distanza non
  aggiungono informazione e tengono aperto un canale di pressione
  indefinito; 30 giorni combaciano con la retention documentale. Scartata.
- **Contatori denormalizzati su `users`**: più veloci ma stantii e da
  riconciliare; i volumi MVP non lo giustificano (una GROUP BY su indice).
  Scartata, coerente con ADR-010.

## Conseguenze

- La reputazione diventa operativa su tutte le superfici di scelta
  (bacheca, hub, dettaglio) senza denormalizzazioni da mantenere.
- Le recensioni non muovono denaro e non entrano nella macchina a stati:
  vivono in rotte dedicate con guardie proprie, testate una per una
  (spedizione aperta, finestra scaduta, non-partecipante, auto-recensione,
  ruolo non effettivo, doppia recensione).
- Un partecipante può recensire senza essere recensito a sua volta (nessun
  meccanismo di reciprocità o svelamento simultaneo nell'MVP): accettato,
  da rivedere coi dati se emergono ritorsioni sistematiche (RISKS §7).
- Il claimant guadagna una superficie reputazionale da vettore senza aver
  dichiarato viaggi: coerente con l'economia del claim (incassa compenso da
  vettore, ADR-016).
