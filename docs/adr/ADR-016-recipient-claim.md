# ADR-016 — Ritiro anticipato del destinatario ("recipient claim")

- Stato: accettato (decisione utente) — 2026-07-13; **implementato** lo stesso giorno
- Modifica: [ARCHITECTURE.md](../ARCHITECTURE.md) §4–§5, [ECONOMICS.md](../ECONOMICS.md)
  §5-ter, [ESCROW.md](../ESCROW.md) §3-bis, [MATCHING.md](../MATCHING.md) §3,
  [RISKS.md](../RISKS.md) §7
- Implementazione: `@mercurio/shared` (tipi ed eventi), `@mercurio/core`
  (macchina a stati, `priceClaim`), `@mercurio/db` (migrazione 0005),
  `apps/api` (rotte, mail di tracking, pump, bacheca) — precisazioni in fondo

## Contesto

Il protocollo muove il pacco di hub in hub finché un vettore non completa
l'ultima tratta; il destinatario è passivo fino all'`AWAITING_PICKUP`. Ma il
destinatario è, a tutti gli effetti, il vettore più motivato dell'intera rete:
se il pacco è fermo in un hub raggiungibile, può andarselo a prendere. Senza
un meccanismo dedicato dovrebbe attendere che un vettore accetti la tratta
residua — o peggio, il pacco potrebbe incagliarsi e svincolarsi a fine
giacenza. Decisione utente: dare al destinatario la facoltà di **reclamare il
pacco in anticipo**, incassando lui il compenso residuo, senza toccare gli
invarianti (zero custodia, conservazione dell'impegno, ledger bilanciato).

## Decisione

1. **Credenziale di tracking**: all'`origin_checkin` il destinatario riceve
   una mail di tracking con un **token personale** (QR/stringa). È una
   credenziale bearer: a DB vive solo l'hash (stesso pattern dell'OTP di
   ritiro), il plaintext viaggia esclusivamente nella riga di outbox della
   stessa transazione. Il `reroute` che cambia destinatario **ruota il token**
   e rimanda la mail di tracking al nuovo destinatario: il token del vecchio
   destinatario muore. Le mail a ogni cambio di hub esistono già
   (`parcel_at_intermediate_hub`).
2. **Quando si può reclamare**: con quel token il destinatario può reclamare
   il pacco mentre è fermo in un **qualsiasi hub** del percorso: stato
   `AT_HUB`, nessuna tratta pendente o prenotata. **Non** da
   `AWAITING_PICKUP`: lì esiste già il ritiro OTP e non resta nulla da
   reclamare (pool residuo 0, Π_v consumata). Il claim richiede un **account
   con wallet connesso** (il destinatario incassa) e **ruoli disgiunti**:
   claimant ≠ mittente e ≠ proprietario dell'hub di ritiro — su Lightning
   payer ≠ payee (ADR-013).
3. **Economia del claim** (importi congelati alla richiesta, floor al sat per
   parte — ECONOMICS.md §5-ter):
   - il destinatario incassa il **pool di lavoro residuo**
     `remainingPool(segmento, D, r corrente)` **più la quota vettore Π_v**
     maturata e non ancora consumata (ADR-014): sta facendo lui la tratta
     residua, premio di consegna compreso;
   - l'hub dove avviene il ritiro incassa la **quota hub Π_h** maturata: è
     l'hub che completa la consegna, esattamente il lavoro che Π_h paga
     (ADR-014, alternativa 3);
   - il claim **non paga fee hub**: l'hub di ritiro è già stato compensato
     dalla fee d'arrivo della tratta entrante e il lavoro di consegna è pagato
     da Π_h. **Conseguenza accettata**: un claim all'hub di **origine** dà
     all'hub solo Π_h, nessuna fee — l'hub d'origine non ha mai mosso il pacco
     e la sua fee sarebbe nata solo da una tratta in uscita mai partita;
   - il claim **consuma Π_v**; la conservazione resta invariata: il mittente
     non paga mai più di `P + Σ boost`, i resti di floor restano a lui.
4. **Meccanica dei pagamenti** (ADR-013, stessa forma delle tratte): alla
   richiesta si aprono **due hold** — il **claim payment**
   mittente→destinatario (`purpose: claim_payment`, pool residuo + Π_v) e
   **Π_h** mittente→proprietario dell'hub (`purpose: finalization_bonus`,
   solo se > 0 dopo il floor) — con **finestra di funding di 60 minuti**
   (stessa costante delle tratte). Dalla richiesta il pacco **sparisce dalla
   bacheca** e ogni `leg_accept` è respinto. Tutte le hold _held_ (wallet
   pump) → stato **`CLAIMED`**; finestra scaduta → hold annullate e il pacco
   torna in bacheca. Al **ritiro fisico** (sessione dell'hub + QR del pacco +
   token del destinatario, verificati dall'API → fatti dichiarati alla
   macchina, precisazione 10): preimage del claim payment al destinatario,
   preimage di Π_h all'hub, bond di custodia dell'hub rimborsato →
   `DELIVERED`. Accettare il pacco al ritiro è **accettazione definitiva**
   (ADR-012), come per l'OTP.
5. **La giacenza NON si sospende**: a differenza di una tratta prenotata, il
   claim non muove il pacco né libera la mensola dell'hub. `storage_expiry`
   con claim pendente o in `CLAIMED` → `FORFEITED` con le hold del claim
   annullate/rimborsate — specchio esatto della regola tratta-in-funding.
6. **Interazioni**: `handoff_reject` documentale è ammesso al ritiro del claim
   (stage `recipient_pickup`: stesso atto fisico); `boost`, `reroute` e
   `cancel` sono **respinti** con claim pendente o in `CLAIMED` (il claim ha
   congelato pool e credenziali; il mittente riprova quando il claim si
   risolve).
7. **Un claim che non ha nulla da incassare è respinto**: con pool residuo a 0
   e Π_v consumata il claim payment sarebbe 0 e una hold a importo zero non
   esiste su Lightning; il mittente deve prima fare `boost`, esattamente come
   per sbloccare qualunque vettore. (Il caso: pacco riportato a pool esaurito
   dopo un reroute post-arrivo senza boost.)

## Esempio canonico (P = 5,00 €, D = 100 km, hub al 10% — CLAUDE.md)

Luca ha portato il pacco A→C (40 km, incassa 1,44 € netti; Mario 0,18 €,
Carla 0,18 € di fee d'arrivo). Rita, la destinataria, reclama il pacco a C:

| Voce                        | Calcolo                          | Importo    |
| --------------------------- | -------------------------------- | ---------- |
| Rita: claim payment         | 4,50 × 60/100 **+ 0,35** (Π_v)   | **3,05**   |
| Carla (hub C): Π_h          | quota hub maturata               | **0,15**   |
| Carla, totale               | 0,18 (fee arrivo) + 0,15         | 0,33       |
| Marco, totale pagato        | 1,80 + 3,05 + 0,15               | **5,00** ✓ |

Claim all'hub di **origine** (nessuna tratta ancora partita): Rita incassa
4,50 + 0,35 = **4,85 €**, Mario solo Π_h = **0,15 €**, Marco 5,00 € spaccati.

## Alternative considerate

- **Claim anche da `AWAITING_PICKUP`**: lì il ritiro OTP esiste già e il pool
  è a zero con Π_v consumata — un "claim" non avrebbe nulla da pagare e
  duplicherebbe un flusso funzionante. Scartata.
- **Claim come tratta fittizia a distanza zero** (riusare `leg_accept` con il
  destinatario come vettore): abusa della semantica delle tratte (bond del
  vettore, fee di partenza/arrivo, viaggio dichiarato, bacheca) per un atto
  che non trasporta nulla e non cambia custode fino al ritiro. Scartata: gli
  importi del claim non sono quelli di una tratta.
- **Fee hub anche sul claim**: l'hub è già compensato dalla fee d'arrivo della
  tratta entrante (pagata sul posto, mai claw-back) e il lavoro di consegna è
  il lavoro che Π_h paga. Una fee in più pagherebbe due volte lo stesso
  servizio, erodendo il compenso del destinatario. Scartata.
- **Sospendere la giacenza durante il claim**: terrebbe la mensola occupata a
  tempo indeterminato con un claim mai ritirato (griefing a costo zero verso
  l'hub). La giacenza che corre è la stessa regola delle tratte in funding e
  il claim si esaurisce da sé alla scadenza. Scartata.
- **Pagamento istantaneo al ritiro invece delle hold**: il destinatario si
  presenterebbe all'hub senza garanzia che il mittente paghi (lavorerebbe "a
  credito" come il vettore senza hold, ESCROW §3). Scartata: stessa forma
  delle tratte, fondi vincolati prima del viaggio verso l'hub.
- **Vincolare il claim all'email del destinatario** (account con la stessa
  email): romperebbe il caso reale di un destinatario che si registra con
  un'altra email e non aggiunge sicurezza (chi ha accesso alla casella ha il
  token comunque). Il token È la credenziale — bearer, come l'OTP. Scartata.

## Conseguenze

- **Zero custodia invariata**: due hold P2P in più, sempre mittente→utente;
  la piattaforma continua a detenere solo preimage. Default sicuro: se tutto
  muore, le hold del claim scadono e il mittente rientra.
- **Conservazione invariata**: `Σ lordi tratte + claim payment ≤ 90% ×
  (P + Σ boost)` per costruzione (il claim liquida il pool residuo alla `r`
  corrente); ogni quota del premio si consuma al più una volta (il claim
  consuma Π_v e paga Π_h). Il mittente paga al più `P + Σ boost`, spaccato.
- **Il mittente non sceglie**: il claim è un diritto del destinatario (via
  token che il mittente stesso ha innescato compilando l'email). Il costo per
  il mittente è identico alla consegna completata: stesso impegno, stessa
  ripartizione — cambia solo chi fa l'ultimo miglio.
- **L'hub di ritiro guadagna Π_h senza tratta in uscita**: per un hub
  intermedio il claim è un buon affare (fee d'arrivo già incassata + Π_h);
  per l'hub di origine è solo Π_h — accettato, vedi Decisione 3.
- **Un vettore può trovare la bacheca svuotata da un claim**: finché il claim
  pende (≤ 60 min) o è `CLAIMED`, il pacco non è prenotabile; se il claim
  scade, il pacco riappare. Finestra breve e identica a quella delle tratte.
- **Profilo anti-abuso** annotato in RISKS §7: token bearer rubato,
  claim-griefing da 60 minuti, claim senza ritiro. Sintesi: il token può solo
  far incassare il legittimo flusso al suo portatore autenticato con wallet
  (mai deviare fondi verso terzi arbitrari), il griefing costa un account +
  wallet ed è tracciato in `shipment_claims`, e un claim non ritirato termina
  in `FORFEITED` dove il claimant perde il pacco e ogni compenso.
- **Il destinatario diventa un attore economico**: serve wallet Lightning
  anche a lui (solo per il claim; il ritiro OTP resta senza requisiti). È la
  stessa frizione dichiarata di ADR-013, opt-in.

## Precisazioni implementative (2026-07-13)

Decisioni emerse implementando, nessuna cambia il protocollo qui sopra:

1. **Le hold del claim referenziano il claim** (`conditional_payments.ref_type
   = 'claim'` → riga `shipment_claims`), non l'`hub_stay`: la hold Π_h di una
   vecchia tratta finale annullata sullo stesso stay produrrebbe altrimenti la
   stessa chiave idempotente `cpc:hub_stay:<id>:finalization_bonus` e il
   coordinatore restituirebbe la hold morta. Per la stessa ragione
   `ctx.finalizationBonusHold` (la Π_h di una TRATTA) esclude le hold con ref
   `claim`: la Π_h del claim vive in `ctx.pendingClaim` e le due non si
   aliasano mai.
2. **`ctx.pendingClaim` è lo specchio di `ActiveLeg`**: id, claimant, stay,
   importi congelati, id delle hold, deadline. Presente dalla richiesta alla
   risoluzione; la sua presenza è ciò che respinge `leg_accept`/`boost`/
   `reroute`/`cancel` e nasconde il pacco dalla bacheca.
3. **Journal entry accoppiate** con le stesse chiavi collassanti di ADR-013:
   `claim_payment_held/released/refunded` e, per la Π_h del claim,
   `finalization_bonus_held/released/refunded` sotto `cp:<paymentId>:<...>`.
   Come per le tratte, gli impegni entrano nel ledger solo a `claim_funded`:
   una hold annullata in finestra non è mai stata un impegno.
4. **Eventi di custodia**: `claim_requested` (nuovo tipo), `funded` (riusato,
   payload con `claimId` — come il funding delle tratte), `expired` con
   `reason: 'claim_funding'` (specchio di `leg_funding`), `recipient_claimed`
   (nuovo tipo, chiusura). Ogni transizione un evento, mai PII nel payload.
5. **`handoff_reject` allo stage `recipient_pickup` copre anche `CLAIMED`**:
   stesso atto fisico (il destinatario ritira all'hub), nessun nuovo valore
   dell'enum `rejection_stage`.
6. **Il claim a pool+Π_v = 0 è respinto dalla macchina** (`guard_failed`), non
   dalla rotta: la regola è di protocollo (le hold a zero non esistono), non
   di trasporto.
7. **Tabella `shipment_claims`** come storia completa (mai cancellata):
   claimant, stay, importi, cp id, stato, deadline; indice unico parziale su
   `shipment_id WHERE status IN ('pending_funding','funded')` — al più un
   claim vivo per spedizione anche a livello di database.
8. **Il pump del funding è generico**: stessa passata di osservazione delle
   tratte; un claim ha 2 hold richieste (1 se Π_h floora a 0) e la macchina
   respinge il funding oltre la finestra — le osservazioni tardive sono
   benigne, come per i leg.
9. **Il claimant è un partecipante della spedizione** (`GET /shipments/:id`):
   gli serve vedere lo stato per sapere quando il claim è `CLAIMED` e può
   presentarsi al banco.
