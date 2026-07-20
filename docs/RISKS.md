# Mercurio — Rischi e domande aperte

> Stato: **bozza per revisione** — 2026-07-12; voci ⚖️ chiuse il 2026-07-17.
> Ogni voce: rischio → proposta → stato. Le voci ⚖️ segnalavano le verifiche
> normative pre-mainnet: sono chiuse come decisioni di progetto motivate dalle
> norme (§2, §4, §5, §6) e non bloccano più il mainnet; i testi (ToS,
> informativa privacy) sono redatti in [docs/legal](legal/TOS.md) — resta il
> todo umano della revisione da parte di un legale (§8).

## 1. Integrità del pacco — senza arbitri e senza finestra di contestazione

> Decisione utente (2026-07-12): niente finestra di contestazione ("se accetti il
> pacco, fine") e nessun arbitro. Formalizzata in [ADR-012](adr/ADR-012-no-arbiter.md).

**Problema**: "pacco integro e consegnato" è la condizione che sblocca bond e payout,
ma l'integrità non è verificabile oggettivamente da un software, e nessun essere
umano deve doverla giudicare.

**Soluzione — certificazione ai passaggi di mano + esiti solo deterministici**:

- Il mittente sigilla il pacco; foto consigliate di contenuto e pacco sigillato alla
  creazione (sono la sua unica tutela documentale).
- A ogni passaggio di mano chi riceve ha due sole mosse: **accettare** (foto +
  conferma "integro": la custodia passa, bond e payout del custode precedente si
  sbloccano) o **rifiutare** (`handoff_reject`: foto + motivo, la custodia NON passa).
  Chi accetta senza guardare si assume il rischio: **la responsabilità segue la
  custodia certificata** (ARCHITECTURE §5).
- Al **ritiro finale** il destinatario ispeziona e poi digita l'OTP: è l'accettazione
  definitiva, la spedizione si chiude lì. Nessuna finestra di contestazione.
- Il denaro si muove **solo per regole meccaniche**: certificazione → il vettore
  incassa (rivelazione della preimage, ADR-013); `pickup_timeout`/`transit_timeout`
  → il mittente incassa il bond del vettore; `storage_expiry` → pacco svincolato
  all'hub. Mai per giudizio di un arbitro.

**Come si risolvono i casi brutti, senza arbitro**:

- _Vettore con pacco danneggiato in mano_: nessun hub glielo accetta → o lo riporta
  all'hub di partenza (`leg_return`: bond restituito, nessun payout — l'hub cedente è
  tenuto a riaccettare ciò che ha certificato al check-out) o scatta il
  `transit_timeout` e il suo bond va al mittente. Deterministico.
- _Destinatario che rifiuta il ritiro_: il pacco resta all'hub; il mittente viene
  notificato e può fare `reroute` (anche verso l'origine, con se stesso come
  destinatario = richiamo del pacco) e/o `boost`; altrimenti giacenza → svincolo.
- _Rifiuto pretestuoso (griefing)_: il rifiuto non muove denaro, quindi non c'è nulla
  da guadagnare; i rifiuti sono registrati in catena di custodia e pesano sulla
  reputazione di chi li accumula.

**Costo dichiarato del modello** (accettato by design): nei casi non provabili —
danno emerso dove nessuna regola meccanica individua un responsabile — **nessuno
viene risarcito**: la perdita resta al mittente, la reputazione punisce i recidivi.
In cambio: niente potere discrezionale della piattaforma sui fondi degli utenti,
niente collo di bottiglia umano, niente pressioni sull'arbitro con bond da 1.000 €.
Il gestore non ha alcun ruolo nei movimenti di denaro (nemmeno di controllo
preventivo — §5): tutto è deciso dalle regole ed eseguito dal software.

**Limite accettato**: contenuti difformi _dentro_ un pacco mai aperto non sono
verificabili; mitigazione: tetto di valore dichiarabile (§2), foto del contenuto
come pratica consigliata, reputazione.

## 2. Anti-abuso sui contenuti non dichiarati

**Problema**: Mercurio permette contenuto non dichiarato; il rischio è diventare un
canale per merce illegale, con esposizione di hub e vettori.

**Proposte**:

- **Opt-in esplicito**: hub e vettori vedono il flag "contenuto non dichiarato" prima
  di accettare; gli hub lo configurano in registrazione (già in specifica). Chi non
  fa opt-in non riceve mai questi pacchi dal matching.
- **ToS**: il mittente autodichiara la liceità del contenuto e ne resta l'unico
  responsabile; hub e vettori sono meri detentori in buona fede — senza
  rappresentazione né volontà dell'illecito non c'è responsabilità penale
  (artt. 42-43 c.p.), e il diritto di rifiuto (sotto) rende la buona fede
  concretamente esercitabile. Formulazione confermata (2026-07-17).
- **Disclaimer unico nei ToS**: lista di esclusione (armi, sostanze, denaro contante,
  animali, batterie non protette…) **insieme al tetto di valore dichiarabile di
  45 €**. La soglia riprende la franchigia doganale UE per le spedizioni
  occasionali tra privati (Reg. (CE) 1186/2009, artt. 25-27; Dir. 2006/79/CE):
  intra-UE la dogana non esiste, ma il tetto tiene la porta
  aperta a un'estensione extra-UE futura senza cambiare le regole. Limiti fisici
  (dimensioni/peso) già configurati per hub.
- **Il tetto di valore non è un tetto di cura**: il mittente può chiedere un **bond
  di custodia fino a 1.000 €** (oggetti di valore affettivo: chi li tocca deve farci
  attenzione) e **offrire liberamente qualsiasi cifra** per la spedizione (più offri,
  prima un vettore la prende — l'effetto asta è implicito nel ranking della bacheca,
  MATCHING §3). Contropartite in §5 e §7.
- **Diritto di rifiuto in ogni momento**: hub e vettori possono sempre rifiutare un
  pacco sospetto (`handoff_reject`, §1): il rifiuto non muove denaro e non comporta
  penalità — al massimo pesa sulla reputazione se sistematico e immotivato.
- **Nessun canale di segnalazione alle autorità dentro il prodotto**: un
  malfunzionamento o un abuso del meccanismo genererebbe false segnalazioni, con
  danni seri agli utenti. Le segnalazioni sono una **procedura operativa manuale e
  documentata del gestore**, fuori dal software; dentro il prodotto esistono
  solo il rifiuto documentato del pacco (§1). Sulla piattaforma non grava alcun
  obbligo generale di sorveglianza sui contenuti intermediati
  (Reg. (UE) 2022/2065 — DSA).
- Niente spedizioni extra-UE nell'MVP (dogana e IVA import = altro pianeta di
  problemi); il tetto a 45 € è comunque già allineato per quando servirà.

Stato: **formulazioni confermate e redatte (2026-07-17)** — autodichiarazione,
lista di esclusione e tetto di valore sono i §6 (e §5 per il bond) di
[legal/TOS.md](legal/TOS.md).

## 3. Identità degli utenti

**Problema**: solo email = account usa-e-getta facili (Sybil); KYC = uccide il progetto.

**Proposta — economica, non anagrafica**:

- **Email verificata obbligatoria per tutti** (magic link): serve comunque come canale
  operativo (notifiche a mittente/destinatario sono parte del flusso) e dà un costo
  minimo di frizione. **LNURL-auth opzionale** come secondo metodo di login,
  coerente col pubblico e con la Bitcoin Design Guide ([ADR-009](adr/ADR-009-auth-email-lnurl.md)).
- La vera resistenza Sybil sono i **bond**: un account nuovo che vuole toccare pacchi
  deve bloccare denaro. Un attaccante che brucia account brucia bond.
- **Reputazione per ruolo** (già in specifica) mostrata a ogni scelta di controparte;
  account nuovi partono senza storia e il mercato li prezza da solo.
- Gli **hub** sono attività fisiche con indirizzo pubblicato: di fatto identificati.
  MVP: verifica soft (visita/foto della vetrina); niente KYB formale ma campo per
  P.IVA facoltativo (nota: se un hub incassa sistematicamente, il profilo
  fiscale è suo, non della piattaforma).

Stato: **raccomandata email+LNURL-auth; da confermare in revisione**.

## 4. ⚖️ Fine giacenza: da "distruzione" a "svincolo"

**Problema**: la "distruzione" del pacco a fine giacenza è legalmente insostenibile
(distruzione dolosa di cosa altrui; il deposito nel codice civile italiano impone
custodia e restituzione — artt. 1766 ss. c.c.).

**Proposta di riformulazione (già recepita nel CLAUDE.md come "svincolo")**:

- Alla scadenza della giacenza scelta dal mittente il pacco diventa **svincolato
  secondo ToS**: il bene stesso compensa l'hub per lo stoccaggio
  (con l'architettura zero-custodia non esiste un escrow prefinanziato da girargli —
  ADR-013; il bond dell'hub viene semplicemente annullato).
- Nei ToS lo svincolo si articola in una **cascata con preavvisi**: (1) notifiche a
  mittente e destinatario a 72h e 24h dalla scadenza; (2) alla scadenza, periodo di
  ulteriori N giorni in cui il mittente può ancora recuperare il pacco pagando lo
  stoccaggio extra direttamente all'hub; (3) oltre, lo svincolo opera **in forma
  marciana**: l'hub trattiene il bene a compensazione del credito di stoccaggio
  maturato alle tariffe pubblicate nel suo profilo; la stima del bene usa il
  **valore dichiarato dal mittente (≤ 45 €, §2) come tetto** e l'eventuale
  eccedenza rispetto al credito è riconosciuta al mittente. Opzione
  preferenziale: **donazione documentata a ente benefico**; **smaltimento** solo
  per beni deperibili o di valore nullo, con motivazione registrata — mai
  "distruzione" come termine contrattuale. In ogni fase resta offerto il
  default: **reroute di richiamo verso l'origine**, con il mittente come
  destinatario di se stesso (§1).

**Chiusura (2026-07-17)** — decisione di progetto motivata dalle norme:

- Il rapporto hub–mittente è un deposito oneroso (artt. 1766 ss. c.c.)
  accessorio a un contratto atipico di logistica tra privati; la clausola di
  svincolo è approvata specificamente per iscritto (artt. 1341-1342 c.c.).
- La forma marciana supera il divieto di patto commissorio (art. 2744 c.c.):
  valutazione ancorata a un criterio oggettivo fissato ex ante (il valore
  dichiarato ≤ 45 € come tetto) ed eccedenza restituita al debitore — schema
  riconosciuto dalla giurisprudenza di legittimità (Cass. 1625/2015) e ormai
  tipizzato dal legislatore (artt. 48-bis e 120-quinquiesdecies TUB).
- Verso il consumatore la clausola regge il vaglio degli artt. 33-36
  d.lgs. 206/2005: preavvisi, finestra di recupero, richiamo sempre
  disponibile, tariffe di stoccaggio pubblicate prima dell'accettazione —
  nessun significativo squilibrio a danno del mittente.
- L'ordinamento già consente a chi custodisce o trasporta di soddisfarsi sul
  bene: privilegio del vettore sulle cose trasportate (art. 2756 c.c.), rimedi
  del vettore per impedimenti alla riconsegna (artt. 1686 e 1690 c.c.),
  realizzo del pegno (artt. 2796-2797 c.c.); per il caso limite del bene
  derelitto vale l'art. 923 c.c. Lo svincolo marciano è la variante
  contrattuale — più tutelante — di questi istituti.
- Prassi di settore coerente: i corrieri applicano tariffe di giacenza e poi
  svincolano o realizzano gli invii non ritirati; le condizioni postali
  prevedono la devoluzione degli invii in giacenza non reclamati; il
  self-storage applica clausole di ritenzione e realizzo per canoni non
  pagati. Il modello Mercurio aggiunge tutele che quella prassi non ha: tetto
  di valore basso, eccedenza riconosciuta, richiamo sempre possibile.

Stato: **chiuso e redatto (2026-07-17)** — la cascata è il §10 di
[legal/TOS.md](legal/TOS.md). Decisioni prese in redazione (la soluzione più
semplice coerente con la chiusura qui sopra): la finestra di recupero è
fissata a **7 giorni** di calendario; la tariffa di giacenza extra è **unica e
fissata nei ToS** — 1/30 del tetto di valore per giorno iniziato, cioè
1,50 €/giorno — invece delle tariffe per-hub (pubblicata ex ante per tutti,
nessun campo nuovo a schema); i preavvisi a 72/24 h sono implementati dal
worker `storage-warnings` sul timer `storage` armato (mai in contraddizione
con la macchina: un timer disarmato non esiste più).

## 5. Perimetro normativo — risolto by design: zero custodia

**Decisione (2026-07-12)**: in nessun momento il sistema custodisce fondi
([ADR-013](adr/ADR-013-non-custodial-coordinator.md)). Ogni pagamento è una hold
invoice o una invoice istantanea **direttamente tra due utenti**; la piattaforma
detiene solo le preimage. I fondi sono sempre o nel wallet del pagatore o in-flight
verso il beneficiario fissato ex-ante; se la piattaforma sparisce, tutto torna ai
pagatori. Il perimetro custodial MiCA/PSD2 **non si applica per costruzione**.

**Nessun controllo AML preventivo** (decisione 2026-07-12): niente trattenute,
niente review sulle offerte. Con lo zero-custodia l'argomento si rafforza: non
esistono "fondi di clienti" su cui esercitare controlli; resta la piena
tracciabilità interna (ledger ombra + catena di custodia con identità email).

Verifica residua chiusa (2026-07-17) — decisione di progetto motivata dalle
norme: i pagamenti Lightning sono fuori dal perimetro PSD2 **per oggetto**. La
direttiva (Dir. (UE) 2015/2366, recepita con d.lgs. 218/2017) si applica ai
"fondi" definiti all'art. 4 n. 25 — banconote e monete, moneta scritturale,
moneta elettronica — e i satoshi non vi rientrano: senza fondi non c'è servizio
di pagamento, quindi nemmeno una disposizione di ordini di pagamento (PISP) da
autorizzare. MiCA (Reg. (UE) 2023/1114) non cattura la piattaforma: nessuna
custodia né trasferimento di cripto-attività per conto di clienti (ADR-013 —
ogni pagamento è approvato dall'utente nel _proprio_ wallet; la piattaforma
propone, non dispone). L'impianto resta coerente con il d.lgs. 231/2007:
nessuna custodia né conversione per conto terzi, piena tracciabilità interna
(ledger ombra + catena di custodia).

**Nuovi rischi introdotti dallo zero-custodia** (il prezzo della scelta, accettato):

| Rischio                                                                                       | Gestione                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Wallet capaci di hold invoice richiesti (LND/CLN/Alby Hub) = frizione di onboarding           | Connessione via NWC + adapter diretti; guide; è la selezione naturale del pubblico early-adopter   |
| HTLC pendenti a lungo = liquidità congelata, rischio force-close | **Rinnovo rolling del bond hub** (ADR-033): ogni hold ≤7 giorni, giacenza fino a 30; mancato rinnovo = svincolo anticipato |
| Mittente non reattivo: ogni tratta parte solo dopo il suo pagamento (finestra 60 min)         | Notifiche push/email; metrica di reattività visibile in bacheca; l'accettazione decade senza danni |
| UX dei pagamenti pendenti su alcuni wallet                                                    | Lista di wallet testati/consigliati; documentazione                                                |

Stato: **chiuso** — by design (2026-07-12) e per perimetro normativo (2026-07-17).

## 6. GDPR

- **Email del destinatario inserita dal mittente** (dato di terzo): base =
  legittimo interesse (art. 6(1)(f) GDPR; per le parti del contratto la base è
  l'esecuzione del contratto stesso, art. 6(1)(b)), uso strettamente
  transazionale, informativa al primo contatto (art. 14) e link di opposizione
  in ogni mail (art. 21). Basi confermate (2026-07-17).
- **Foto**: retention limitata (`purge_after`: chiusura spedizione + 30 giorni,
  con tetto di 90 giorni dall'upload — implementata dal purge worker di
  ADR-020 §5, che attua minimizzazione e limitazione della conservazione,
  art. 5(1)(c) ed (e) GDPR), niente volti richiesti dal flusso; metadati EXIF
  (geotag) rimossi sul dispositivo prima dell'hash e rifiutati dal server
  (ADR-020 §2); alla cancellazione account le foto scattate dall'utente per
  spedizioni chiuse sono eliminate subito (ADR-020 §6).
- **Cancellazione account** (art. 17): anonimizzazione — il ledger e la catena
  di custodia restano (obbligo contabile e integrità del sistema) ma scollegati
  dai dati personali.
- **Export dei propri dati** (art. 20): endpoint dedicato (requisito CLAUDE.md).
- **Geolocalizzazione dei viaggi vettore**: si salvano solo origine/destinazione
  dichiarate, mai tracking GPS continuo.

Stato: **basi giuridiche confermate e informativa redatta (2026-07-17)** —
[legal/PRIVACY.md](legal/PRIVACY.md), pubblicata su `/privacy`. L'informativa
al primo contatto (art. 14) e il link di opposizione (art. 21) viaggiano nelle
email del ciclo di vita (outbox worker); export, cancellazione e purge foto
erano già implementati.

## 7. Altri rischi operativi (sintesi)

| Rischio                                                                                                  | Proposta                                                                                                                                                                                                                                                                                                                                     | Stato                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Collusione vettore+hub (finto check-in per liberare bond e payout)                                       | La collusione paga solo se il pacco sparisce: il custode certificante resta responsabile verso valle; bond ≥ valore del pacco (il mittente dimensiona il bond, la UI lo suggerisce = valore + spedizione); reputazione                                                                                                                       | Mitigato by design               |
| QR clonato / pacco fotografato                                                                           | Il QR da solo non autorizza nulla: serve sessione autenticata + OTP al ritiro (ARCHITECTURE §7)                                                                                                                                                                                                                                              | Mitigato by design               |
| Vettore sparisce col pacco                                                                               | `transit_timeout` → bond al mittente + rimborso residuo escrow; il bond dimensionato dal mittente è l'assicurazione                                                                                                                                                                                                                          | Mitigato (se bond ≥ valore)      |
| Hub chiude/sparisce con pacchi in giacenza                                                               | Bond hub attivo per ogni pacco in custodia; rating; verifica soft dell'attività                                                                                                                                                                                                                                                              | Parziale — accettato per MVP     |
| Volatilità EUR/sats durante la spedizione                                                                | Cambio congelato al funding; chi incassa sats accetta il rischio sats (esplicitato in UI)                                                                                                                                                                                                                                                    | Accettato, documentato           |
| Manipolazione della tariffa suggerita                                                                    | Solo tratte completate nel campione, p25, minimo 30 osservazioni (MATCHING §4)                                                                                                                                                                                                                                                               | Mitigato                         |
| Escrow/bond usati come canale di trasferimento di valore                                                 | Rischio accettato senza controlli preventivi (decisione 2026-07-12, §5): i beneficiari di ogni hold sono fissati dal protocollo, mai scelti dalle parti; tutto è tracciato in ledger e catena di custodia con identità email — un pessimo strumento per chi vuole nascondere qualcosa. Si riapre solo se il quadro normativo cambia (perimetro confermato in §5, 2026-07-17) | Accettato by design              |
| Bond alti (fino a 1.000 €) restringono la platea di vettori e hub disposti/capaci di bloccarli           | Scelta consapevole del mittente: la UI mostra l'impatto stimato sul tempo di consegna ("con questo bond, X vettori compatibili in zona"); il mercato prezza                                                                                                                                                                                  | Accettato by design              |
| Casi non provabili: danno senza responsabile individuabile dalle regole meccaniche → nessun risarcimento | Costo dichiarato del modello senza arbitro (ADR-012): la certificazione ai passaggi riduce i casi al minimo, la reputazione punisce i recidivi, le foto del mittente restano la sua tutela documentale                                                                                                                                       | Accettato by design              |
| Piattaforma compromessa (DB delle preimage)                                                              | Non c'è nulla da rubare: chi ottiene una preimage può solo far incassare in anticipo il **legittimo beneficiario** già fissato, o negare un esito (e allora i fondi tornano al pagatore alla scadenza). Preimage cifrate a riposo; default sicuro                                                                                            | Mitigato by design (ADR-013)     |
| **Token di claim rubato** (ADR-016): chi lo possiede può reclamare il pacco                              | È una credenziale bearer come l'OTP, ma può muovere denaro: hash a DB, plaintext solo nella mail di tracking, rotazione automatica al cambio di destinatario, rate limit sulle rotte. Chi lo usa deve comunque autenticarsi con un account e incassare sul **proprio** wallet: il flusso resta quello previsto dal protocollo (pool residuo al portatore del token, Π_h all'hub) — mai fondi deviati verso terzi arbitrari — e tutto è tracciato in `shipment_claims` e in catena di custodia. Il furto del token equivale al furto della mail del destinatario, che già consente il ritiro OTP a destinazione | Mitigato by design               |
| **Claim-griefing**: richieste di claim ripetute per togliere il pacco dalla bacheca (finestre da 60 min) | Ogni claim richiede account + wallet connesso e ruoli disgiunti; ogni richiesta è una riga permanente in `shipment_claims` e un evento in catena di custodia (pattern visibile e attribuibile); il rate limit frena la ripetizione. Un claim non finanziato scade da solo e il pacco torna in bacheca; la giacenza intanto continua a correre — il griefer non ferma l'orologio                                                                                              | Mitigato; da monitorare coi dati |
| **Claim senza ritiro**: il destinatario fa `CLAIMED` e non si presenta                                   | La giacenza non si sospende (ADR-016): alla scadenza il pacco è svincolato all'hub (`FORFEITED`), le hold del claim tornano al mittente e il claimant perde pacco e compenso — autopunitivo. Il costo del mancato ritiro ricade su chi l'ha causato                                                                                          | Mitigato by design               |
| Nessuna assicurazione sul trasporto                                                                      | Fuori scope MVP: il bond È l'assicurazione peer-to-peer; comunicarlo chiaramente                                                                                                                                                                                                                                                             | Esplicitato (TOS.md §8 e §15)    |

## 8. Decisioni prese e punti ancora aperti

**Decise in revisione (2026-07-12)**:

1. Bond di custodia unico per hub e vettori, fissato dal mittente (ARCHITECTURE §6). ✔
2. Modello B con fee hub calcolate sul lordo della tratta; l'esempio canonico del
   CLAUDE.md va aggiornato (Luca: lordo 2,00 €, netto 1,60 €). ✔
3. Valore dichiarabile ≤ 45 € nei ToS (insieme alle merci vietate), bond fino a
   1.000 €, offerta libera con prezzo consigliato al mittente (MATCHING §5). ✔
4. **Nessuna finestra di contestazione**: il ritiro con OTP è accettazione
   definitiva. ✔
5. **Nessun arbitro**: esiti solo deterministici, rifiuto al posto della disputa
   (ADR-012, §1). ✔
6. Fee di piattaforma 0% nell'MVP. ✔
7. Documenti in italiano ora; traduzione inglese prima della pubblicazione. ✔
8. Il mittente può fare **boost** (aggiungere fondi) e **reroute** (cambiare hub di
   destinazione e/o destinatario) a pacco fermo (ARCHITECTURE §5, ECONOMICS §5). ✔
9. **Nessun controllo AML preventivo** (niente trattenute né review sulle offerte):
   la tracciabilità del ledger è la mitigazione (§5, §7). ✔
10. **Zero custodia in ogni momento** (ADR-013): pagamenti diretti P2P via hold
    invoice, coordinatore per preimage, la piattaforma non ha wallet; giacenza
    fino a 30 giorni col bond hub a rinnovo rolling (ADR-033). ✔

**Ancora aperti**:

- Nessun punto ⚖️ blocca più il mainnet: formulazioni anti-abuso (§2), svincolo
  a fine giacenza in forma marciana (§4), perimetro PSD2/MiCA (§5) e basi GDPR
  (§6) sono stati chiusi il 2026-07-17 come decisioni di progetto motivate
  dalle norme. I testi sono redatti lo stesso giorno:
  [legal/TOS.md](legal/TOS.md) e [legal/PRIVACY.md](legal/PRIVACY.md),
  pubblicati su `/tos` e `/privacy` (it/en) e accettati al primo login con
  approvazione specifica delle clausole onerose (artt. 1341-1342 c.c.).
- Todo umano, non di sviluppo: **revisione dei testi legali da parte di un
  legale** prima del mainnet pubblico; al deploy di ogni istanza vanno
  compilati Gestore/Titolare e fornitore SMTP nelle pagine `/tos` e
  `/privacy`.
