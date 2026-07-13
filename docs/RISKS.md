# Mercurio — Rischi e domande aperte

> Stato: **bozza per revisione** — 2026-07-12.
> Ogni voce: rischio → proposta → stato. Le voci ⚖️ richiedono verifica legale prima del mainnet.

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
- **ToS**: il mittente dichiara legalmente la liceità del contenuto e resta l'unico
  responsabile (⚖️ formulazione da legale: hub e vettori come meri detentori,
  analogia col vettore in buona fede).
- **Disclaimer unico nei ToS**: lista di esclusione (armi, sostanze, denaro contante,
  animali, batterie non protette…) **insieme al tetto di valore dichiarabile di
  45 €**. La soglia coincide con la franchigia doganale UE per le spedizioni
  occasionali tra privati: intra-UE la dogana non esiste, ma il tetto tiene la porta
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
  documentata del gestore** (⚖️), fuori dal software; dentro il prodotto esistono
  solo il rifiuto documentato del pacco (§1).
- Niente spedizioni extra-UE nell'MVP (dogana e IVA import = altro pianeta di
  problemi); il tetto a 45 € è comunque già allineato per quando servirà.

Stato: **proposte pronte; formulazioni ToS da legale**.

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
  P.IVA facoltativo (⚖️ se un hub incassa sistematicamente, profilo fiscale suo).

Stato: **raccomandata email+LNURL-auth; da confermare in revisione**.

## 4. ⚖️ Fine giacenza: da "distruzione" a "svincolo"

**Problema**: la "distruzione" del pacco a fine giacenza è legalmente insostenibile
(distruzione dolosa di cosa altrui; il deposito nel codice civile italiano impone
custodia e restituzione — artt. 1766 ss. c.c.).

**Proposta di riformulazione (già recepita nel CLAUDE.md come "svincolo")**:

- Alla scadenza della giacenza scelta dal mittente il pacco diventa **svincolato
  secondo ToS**: il bene stesso è la compensazione dell'hub per lo stoccaggio
  (con l'architettura zero-custodia non esiste un escrow prefinanziato da girargli —
  ADR-013; il bond dell'hub viene semplicemente annullato).
- Nei ToS lo svincolo si articola in una **cascata con preavvisi**: (1) notifiche a
  mittente e destinatario a 72h e 24h dalla scadenza; (2) alla scadenza, periodo di
  ulteriori N giorni in cui il mittente può ancora recuperare il pacco pagando lo
  stoccaggio extra direttamente all'hub; (3) oltre, l'hub può disporne: restituzione,
  donazione, smaltimento — mai "distruzione" come termine contrattuale.
- ⚖️ Un legale deve verificare: qualificazione del rapporto (deposito vs contratto
  atipico), validità della clausola di svincolo verso un consumatore (clausole
  vessatorie, doppia sottoscrizione), obblighi dell'hub su beni abbandonati.

Stato: **riformulazione proposta; parere legale necessario prima del mainnet**.

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

⚖️ Verifica legale residua (leggera, non bloccante per lo sviluppo): che
l'orchestrazione dei pagamenti via NWC non qualifichi la piattaforma come servizio
di disposizione di ordini di pagamento (PISP, PSD2) — difesa: ogni pagamento è
approvato dall'utente nel _proprio_ wallet; la piattaforma propone, non dispone.

**Nuovi rischi introdotti dallo zero-custodia** (il prezzo della scelta, accettato):

| Rischio                                                                                       | Gestione                                                                                           |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Wallet capaci di hold invoice richiesti (LND/CLN/Alby Hub) = frizione di onboarding           | Connessione via NWC + adapter diretti; guide; è la selezione naturale del pubblico early-adopter   |
| HTLC pendenti a lungo (bond hub = intera giacenza) = liquidità congelata, rischio force-close | **Giacenza massima 7 giorni nell'MVP**; rinnovo rolling dei bond come evoluzione                   |
| Mittente non reattivo: ogni tratta parte solo dopo il suo pagamento (finestra 60 min)         | Notifiche push/email; metrica di reattività visibile in bacheca; l'accettazione decade senza danni |
| UX dei pagamenti pendenti su alcuni wallet                                                    | Lista di wallet testati/consigliati; documentazione                                                |

Stato: **chiuso by design; resta solo la verifica PISP ⚖️**.

## 6. GDPR

- **Email del destinatario inserita dal mittente** (dato di terzo): base = legittimo
  interesse, uso strettamente transazionale, informativa al primo contatto e link di
  opposizione in ogni mail. ⚖️ Da validare.
- **Foto**: retention limitata (`purge_after`: chiusura spedizione + 30 giorni),
  niente volti richiesti dal flusso.
- **Cancellazione account**: anonimizzazione — il ledger e la catena di custodia
  restano (obbligo contabile e integrità del sistema) ma scollegati dai dati personali.
- **Export dei propri dati**: endpoint dedicato (requisito CLAUDE.md).
- **Geolocalizzazione dei viaggi vettore**: si salvano solo origine/destinazione
  dichiarate, mai tracking GPS continuo.

Stato: **da implementare by design; informative da legale**.

## 7. Altri rischi operativi (sintesi)

| Rischio                                                                                                  | Proposta                                                                                                                                                                                                                                                                                                                                     | Stato                            |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Collusione vettore+hub (finto check-in per liberare bond e payout)                                       | La collusione paga solo se il pacco sparisce: il custode certificante resta responsabile verso valle; bond ≥ valore del pacco (il mittente dimensiona il bond, la UI lo suggerisce = valore + spedizione); reputazione                                                                                                                       | Mitigato by design               |
| QR clonato / pacco fotografato                                                                           | Il QR da solo non autorizza nulla: serve sessione autenticata + OTP al ritiro (ARCHITECTURE §7)                                                                                                                                                                                                                                              | Mitigato by design               |
| Vettore sparisce col pacco                                                                               | `transit_timeout` → bond al mittente + rimborso residuo escrow; il bond dimensionato dal mittente è l'assicurazione                                                                                                                                                                                                                          | Mitigato (se bond ≥ valore)      |
| Hub chiude/sparisce con pacchi in giacenza                                                               | Bond hub attivo per ogni pacco in custodia; rating; verifica soft dell'attività                                                                                                                                                                                                                                                              | Parziale — accettato per MVP     |
| Volatilità EUR/sats durante la spedizione                                                                | Cambio congelato al funding; chi incassa sats accetta il rischio sats (esplicitato in UI)                                                                                                                                                                                                                                                    | Accettato, documentato           |
| Manipolazione della tariffa suggerita                                                                    | Solo tratte completate nel campione, p25, minimo 30 osservazioni (MATCHING §4)                                                                                                                                                                                                                                                               | Mitigato                         |
| Escrow/bond usati come canale di trasferimento di valore                                                 | Rischio accettato senza controlli preventivi (decisione 2026-07-12, §5): i beneficiari di ogni hold sono fissati dal protocollo, mai scelti dalle parti; tutto è tracciato in ledger e catena di custodia con identità email — un pessimo strumento per chi vuole nascondere qualcosa. ⚖️ Si riapre solo se il parere legale rileva obblighi | Accettato by design              |
| Bond alti (fino a 1.000 €) restringono la platea di vettori e hub disposti/capaci di bloccarli           | Scelta consapevole del mittente: la UI mostra l'impatto stimato sul tempo di consegna ("con questo bond, X vettori compatibili in zona"); il mercato prezza                                                                                                                                                                                  | Accettato by design              |
| Casi non provabili: danno senza responsabile individuabile dalle regole meccaniche → nessun risarcimento | Costo dichiarato del modello senza arbitro (ADR-012): la certificazione ai passaggi riduce i casi al minimo, la reputazione punisce i recidivi, le foto del mittente restano la sua tutela documentale                                                                                                                                       | Accettato by design              |
| Piattaforma compromessa (DB delle preimage)                                                              | Non c'è nulla da rubare: chi ottiene una preimage può solo far incassare in anticipo il **legittimo beneficiario** già fissato, o negare un esito (e allora i fondi tornano al pagatore alla scadenza). Preimage cifrate a riposo; default sicuro                                                                                            | Mitigato by design (ADR-013)     |
| **Token di claim rubato** (ADR-016): chi lo possiede può reclamare il pacco                              | È una credenziale bearer come l'OTP, ma può muovere denaro: hash a DB, plaintext solo nella mail di tracking, rotazione automatica al cambio di destinatario, rate limit sulle rotte. Chi lo usa deve comunque autenticarsi con un account e incassare sul **proprio** wallet: il flusso resta quello previsto dal protocollo (pool residuo al portatore del token, Π_h all'hub) — mai fondi deviati verso terzi arbitrari — e tutto è tracciato in `shipment_claims` e in catena di custodia. Il furto del token equivale al furto della mail del destinatario, che già consente il ritiro OTP a destinazione | Mitigato by design               |
| **Claim-griefing**: richieste di claim ripetute per togliere il pacco dalla bacheca (finestre da 60 min) | Ogni claim richiede account + wallet connesso e ruoli disgiunti; ogni richiesta è una riga permanente in `shipment_claims` e un evento in catena di custodia (pattern visibile e attribuibile); il rate limit frena la ripetizione. Un claim non finanziato scade da solo e il pacco torna in bacheca; la giacenza intanto continua a correre — il griefer non ferma l'orologio                                                                                              | Mitigato; da monitorare coi dati |
| **Claim senza ritiro**: il destinatario fa `CLAIMED` e non si presenta                                   | La giacenza non si sospende (ADR-016): alla scadenza il pacco è svincolato all'hub (`FORFEITED`), le hold del claim tornano al mittente e il claimant perde pacco e compenso — autopunitivo. Il costo del mancato ritiro ricade su chi l'ha causato                                                                                          | Mitigato by design               |
| Nessuna assicurazione sul trasporto                                                                      | Fuori scope MVP: il bond È l'assicurazione peer-to-peer; comunicarlo chiaramente                                                                                                                                                                                                                                                             | Accettato, da esplicitare in ToS |

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
    massima 7 giorni nell'MVP. ✔

**Ancora aperti**:

- Solo i punti ⚖️ (svincolo a fine giacenza, verifica leggera PISP, GDPR,
  formulazioni ToS): richiedono un legale prima del mainnet. Nessuno blocca lo
  sviluppo.
