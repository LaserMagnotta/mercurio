# ADR-027 — L'unico soggetto recensibile è l'hub (emenda ADR-017)

- Stato: accettato — 2026-07-17 (decisione di Giacomo, backlog UX punto 3);
  implementato lo stesso giorno
- Contesto: [ADR-017](ADR-017-reviews.md) (recensioni per ruolo effettivo, che
  questo ADR restringe), CLAUDE.md «Recensioni», RISKS.md §1 e §7 (la
  reputazione è l'unica sanzione senza arbitro), Fase 3 del backlog (scoperta
  hub scalabile: il rating dell'hub è il segnale di ranking)

## Contesto

ADR-017 ha reso recensibile ogni **ruolo effettivo** di una spedizione: il
mittente (`sender`), il vettore di ogni tratta finanziata (`carrier`),
l'hub di ogni giacenza certificata (`hub`), più il claimant come `carrier`.
Tre medie per utente, esposte ovunque si scelga una controparte.

All'atto pratico due di quelle tre medie non informano nessuna scelta:

- **Il mittente** non è una controparte che qualcuno _sceglie_: il vettore
  vede una spedizione, non decide in base a chi l'ha creata (decide in base a
  offerta, deviazione, bond — MATCHING §3). Un rating del mittente è un numero
  che non entra in nessuna decisione, e intanto apre un canale di ritorsione
  contro chi ha solo pagato per spedire.
- **Il vettore** è di passaggio: incrocia una data controparte una volta. Il
  suo rating accumula pochissimo segnale per-controparte e resta soprattutto
  un modo per punirlo dopo un esito già regolato in modo deterministico dal
  protocollo (bond, timeout — ADR-012).
- **L'hub** è l'opposto: un'attività fissa (negozio, bar) che molti mittenti e
  molti vettori incontrano **ripetutamente**. Il suo rating è l'unico che
  descrive un servizio scelto e ricorrente — orari veri, cura del pacco,
  reattività — e l'unica controparte che tiene il pacco a lungo e trattiene una
  fee. È anche il segnale su cui poggerà la scoperta hub della Fase 3 (10k hub
  ordinati per pertinenza e reputazione).

Quindi: **si recensisce solo l'hub.** Una superficie reputazionale sola, quella
che informa una scelta reale e ricorrente.

## Decisione

1. **Soggetto recensibile: esclusivamente l'hub.** `POST /shipments/:id/reviews`
   accetta solo `role: 'hub'`; ogni altro ruolo è respinto con
   `422 subject_not_reviewable`. Restano invariate tutte le altre guardie di
   ADR-017 (spedizione chiusa, finestra 30 giorni, autore partecipante, niente
   auto-recensione, il soggetto ha davvero avuto quel ruolo, una sola per
   `(spedizione, autore, soggetto, ruolo)`).

2. **Autori invariati.** Può ancora recensire ogni **partecipante effettivo**
   (mittente, vettore di tratta finanziata, hub, claimant): tutti hanno
   incontrato l'hub e hanno titolo a giudicarlo. Cambia solo _chi_ si può
   recensire, non _chi_ recensisce.

3. **Aggregati mostrati solo per l'hub**, ovunque:
   - dettaglio spedizione: la lista dei rating tiene solo i partecipanti `hub`;
   - bacheca (MATCHING §3): la card perde il `senderRating` — restano il rating
     dell'hub corrente e di ogni hub di consegna proposto. Il documento è
     emendato di conseguenza;
   - profilo pubblico `GET /users/:id/reviews`: una sola media, quella `hub`, e
     l'elenco delle recensioni ricevute filtrato a `role = 'hub'`.

4. **L'enum resta, si aggiunge soltanto (nessuna rimozione).** `review_role`
   conserva `sender | carrier | hub` — gli enum Postgres si estendono solo in
   aggiunta, e la colonna `reviews.role` non si tocca. La restrizione vive
   nelle **guardie applicative e nei filtri di lettura**, non nello schema.

5. **Le recensioni non-hub esistenti si escludono, non si cancellano.** Come in
   ADR-017 §6, una recensione è un giudizio datato e immutabile: le eventuali
   righe `role IN ('sender','carrier')` già scritte restano a database (e
   nell'export GDPR del loro autore/soggetto) ma **spariscono da ogni lettura**
   — medie e liste filtrano su `role = 'hub'`. Non si riscrive la storia; si
   smette di mostrarla.

## Conseguenze

- Una sola reputazione, quella che conta per una scelta ricorrente: meno
  rumore, meno superficie di ritorsione (RISKS §7), e il segnale già pronto per
  il ranking degli hub della Fase 3.
- Nessuna migrazione di schema: la colonna e l'enum restano. La restrizione è
  tutta in `apps/api` (una guardia sulla POST, tre filtri in lettura) e nella
  UI (il form offre solo hub, le medie di mittente/vettore spariscono).
- Il claimant come `carrier` di ADR-017 perde la superficie reputazionale che
  quell'ADR gli dava: coerente — non essendo più recensibile nessun vettore,
  non lo è nemmeno lui.
- Compatibilità: i client che leggevano `senderRating` sulla card o le medie
  `sender`/`carrier` sul profilo non le trovano più. È un cambio di forma delle
  risposte, dichiarato negli schemi Zod (OpenAPI rigenerata).
- ADR-017 resta in vigore per tutto il resto (stati ammessi, finestra, autori,
  niente modifica/cancellazione, aggregati calcolati in lettura): questo ADR ne
  restringe solo il soggetto.
