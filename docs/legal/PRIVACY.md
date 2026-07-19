# Mercurio — Informativa privacy (artt. 13-14 GDPR)

> **Versione 2026-07-17** — testo di progetto, pubblicato nella pagina
> `/privacy` di ogni istanza. Ogni promessa cita il meccanismo che la
> implementa (ADR-018 §6, ADR-020, ADR-022; decisioni in RISKS.md §6).
> L'unico campo da compilare al deploy è l'identità del Titolare (§1).
> Revisione da parte di un legale: todo umano, tracciato in RISKS §8.

## 1. Titolare del trattamento

Il Titolare è il Gestore di questa istanza di Mercurio, identificato — con i
relativi contatti — nella pagina `/privacy` dell'istanza. Mercurio è software
open source: ogni istanza ha il proprio Titolare.

## 2. A chi si rivolge questa informativa

- **Utenti registrati** (mittenti, vettori, hub, destinatari che ritirano in
  anticipo): l'informativa è resa ai sensi dell'**art. 13** GDPR alla
  creazione dell'account, dove ne viene registrata l'accettazione.
- **Destinatari non registrati**: il mittente inserisce l'email del
  destinatario per le notifiche della spedizione. Per loro l'informativa è
  resa ai sensi dell'**art. 14** GDPR **al primo contatto**: la prima email
  della spedizione (mail di tracking) e ogni email successiva contengono il
  link a questa pagina. **Fonte del dato**: il mittente. **Categorie di
  dati**: indirizzo email; nessun altro dato.

## 3. Quali dati, per quali finalità, su quali basi

| Dati | Finalità | Base giuridica | Conservazione |
| --- | --- | --- | --- |
| Email, locale, data di iscrizione, consensi registrati | account, autenticazione magic link, notifiche operative | esecuzione del contratto (art. 6(1)(b)) | fino alla cancellazione dell'account |
| Dati dell'hub (nome attività, indirizzo, coordinate, orari, vincoli, percentuale) | pubblicazione dell'hub nella rete, matching, calcolo tratte | esecuzione del contratto (art. 6(1)(b)) | fino alla disattivazione/cancellazione |
| Viaggi del vettore (origine, destinazione, deviazione, tariffa) | matching con le spedizioni in bacheca | esecuzione del contratto (art. 6(1)(b)) | fino alla cancellazione dell'account |
| **Email del destinatario** (inserita dal mittente) | notifiche del ciclo di vita della spedizione: tracking, arrivo, codici di ritiro | legittimo interesse (art. 6(1)(f)) all'esecuzione della spedizione; per le parti del contratto, art. 6(1)(b) | per la durata della spedizione; anonimizzata con la cancellazione dell'account del mittente |
| Spedizioni, tratte, giacenze, catena di custodia | coordinamento e prova documentale dei passaggi di mano | esecuzione del contratto (art. 6(1)(b)) | la catena di custodia è append-only e **non contiene dati personali** (§4): resta anche dopo la cancellazione |
| Ledger contabile a partita doppia | tracciabilità dei movimenti osservati, riconciliazione | esecuzione del contratto (art. 6(1)(b)); legittimo interesse all'integrità del sistema (art. 6(1)(f)) | conservato senza dati personali dopo la cancellazione (anonimizzazione, §8) |
| Foto (contenuto, pacco sigillato, passaggi di mano) | tutela documentale delle parti (RISKS §1) | esecuzione del contratto (art. 6(1)(b)); per le controparti di una custodia in corso, legittimo interesse (art. 6(1)(f)) | **al più 90 giorni** dall'upload; **chiusura spedizione + 30 giorni** se la spedizione termina prima (§5) |
| Stringa di connessione del wallet | esecuzione dei pagamenti richiesti dall'utente dal proprio wallet | esecuzione del contratto (art. 6(1)(b)) | cifrata a riposo (§9); eliminata alla cancellazione |
| Recensioni (stelle, commento, autore) | reputazione per ruolo, pubblica | esecuzione del contratto (art. 6(1)(b)) | permanenti; alla cancellazione restano agganciate all'id anonimizzato |

Non c'è alcun trattamento per marketing, profilazione o decisione
automatizzata su persone: gli unici automatismi (esiti deterministici della
macchina a stati) riguardano la spedizione e sono descritti nei
[Termini di servizio](TOS.md) §8.

## 4. Minimizzazione by design

Il principio di minimizzazione (art. 5(1)(c) GDPR) è implementato nel
software, non solo dichiarato:

- **Niente geotag**: le foto sono ri-codificate **sul dispositivo** prima del
  calcolo dell'impronta — i metadati EXIF (posizione GPS, seriale del
  dispositivo) non lasciano mai il telefono; in difesa aggiuntiva il server
  **rifiuta** gli upload che contengono coordinate GPS (ADR-020 §2).
- **Niente tracking GPS dei vettori**: si registrano solo origine e
  destinazione dichiarate del viaggio, mai la posizione in tempo reale
  (RISKS §6).
- **Nessun volto richiesto**: le foto previste dal flusso ritraggono il
  pacco; le vedono solo i partecipanti alla spedizione, mai il pubblico
  (ADR-020 §4).
- **Catena di custodia senza PII**: gli eventi registrano fatti e impronte
  (hash), mai email o altri dati personali — per questo può restare
  immutabile anche dopo una cancellazione (art. 17) senza violarla.
- **Credenziali al portatore mai in chiaro a database**: OTP di ritiro e
  codice personale di tracking sono conservati solo come hash; il QR sul
  pacco contiene un identificatore opaco che da solo non autorizza nulla.
- **Cookie solo tecnici**: `mercurio_session` (sessione, httpOnly) e
  `MERCURIO_LOCALE` (lingua). Nessun cookie di profilazione o di terze
  parti.
- Le URL nelle email portano solo l'id della spedizione: i codici restano
  nel corpo del messaggio (le URL finiscono in cronologie e log, il corpo
  no — ADR-018 §6).

## 5. Foto: ciclo di vita completo (ADR-020, ADR-022)

1. La foto è ri-codificata e ripulita dai metadati sul dispositivo, poi ne
   viene calcolata l'impronta sha256, che entra nella catena di custodia.
2. I byte sono caricati solo dopo la certificazione e serviti **solo via API
   ai partecipanti** della spedizione, con la sessione: mai URL pubbliche.
3. Ogni foto nasce con una data di eliminazione (`purge_after`): al più
   **90 giorni dall'upload**; quando la spedizione si chiude, la data è
   anticipata a **chiusura + 30 giorni**. Un processo giornaliero elimina le
   foto scadute (art. 5(1)(e) GDPR — limitazione della conservazione).
4. Alla cancellazione dell'account, le foto scattate dall'utente per
   spedizioni già chiuse sono eliminate **subito**; quelle di spedizioni in
   corso restano fino alla scadenza naturale del punto 3, come tutela
   documentale delle controparti (art. 6(1)(f)).
5. Le foto della vetrina di un hub (il locale, non i pacchi) restano
   pubblicate finché l'hub è attivo e sono eliminate **subito** — file
   compresi — alla cancellazione dell'account del gestore.

## 6. Destinatari dei dati e trasferimenti

- I dati risiedono nell'infrastruttura del Gestore; le email transazionali
  sono inviate tramite il fornitore SMTP indicato nella pagina `/privacy`
  dell'istanza. Non esistono altri destinatari: nessuna cessione, nessuna
  analisi di terze parti.
- La mappa del percorso vettore carica le tile di OpenStreetMap: il browser
  contatta i server OSM (che vedono l'IP) solo quando la mappa è aperta.
  L'export verso Google Maps avviene **solo se l'utente clicca il link**
  (ADR-018 §4).
- Eventuali trasferimenti extra-UE dipendono dai fornitori scelti
  dall'istanza e sono indicati nella pagina `/privacy` dell'istanza.

## 7. Diritti degli interessati

- **Accesso e portabilità** (artt. 15 e 20): dalla pagina *Account* si
  scarica in un click l'export JSON completo di tutto ciò che l'istanza
  conserva sull'utente — account, hub, viaggi, spedizioni, recensioni,
  storico dei consensi (ADR-018 §6).
- **Cancellazione** (art. 17): dalla stessa pagina, con conferma esplicita.
  La cancellazione **anonimizza**: email e dati personali sono scollegati
  per sempre e le sessioni revocate; ledger e catena di custodia restano —
  non contengono dati personali e garantiscono l'integrità contabile e
  documentale del sistema — agganciati a un identificativo anonimo.
- **Opposizione** (art. 21): il destinatario che non vuole ricevere le email
  di una spedizione può opporsi in ogni momento scrivendo al Titolare
  (contatti nella pagina `/privacy`); ogni email della spedizione contiene
  il link a questa informativa. L'opposizione ferma le notifiche, non la
  spedizione fisica già affidata alla rete.
- **Rettifica** (art. 16) e ogni altro diritto: scrivendo al Titolare.
- **Reclamo**: all'autorità di controllo (per l'Italia, il Garante per la
  protezione dei dati personali — gpdp.it).

## 8. Cancellazione: che cosa resta e perché

La cancellazione dell'account rimuove o scollega tutti i dati personali;
restano, in forma anonimizzata, i fatti che il sistema deve poter provare
anche verso gli altri utenti: le scritture del ledger (movimenti osservati),
gli eventi della catena di custodia (chi ha certificato cosa, come id
anonimo), le recensioni pubblicate. Un eventuale hub viene disattivato. Le
foto seguono il §5.4.

## 9. Sicurezza

- Preimage dei pagamenti e segreti di connessione dei wallet sono cifrati a
  riposo (AES-256-GCM); la piattaforma non ha mai accesso ai fondi
  (ADR-013): anche una compromissione totale del database non permette di
  deviare denaro verso terzi.
- OTP e codici personali sono conservati solo come hash; le rotte di
  verifica sono protette da rate limit.
- La sessione è un cookie httpOnly; le foto sono servite solo con
  autorizzazione di sessione a ogni richiesta.

## 10. Minori

Il servizio è riservato ai maggiorenni (Termini §4); non è previsto alcun
trattamento di dati di minori.

## 11. Modifiche

Le modifiche a questa informativa sono pubblicate su questa pagina con nuova
data di versione; per i cambiamenti sostanziali gli utenti registrati sono
avvisati via email.
