# ADR-014 — Premio di finalizzazione: 10% dell'impegno del mittente al vettore che consegna (70%) e all'hub finale (30%)

- Stato: accettato (decisione utente) — 2026-07-13
- Modifica: [ECONOMICS.md](../ECONOMICS.md) §Premio, [ADR-006](ADR-006-progress-based-economics.md) (resta valido sul 90%)
- Implementazione: **da fare** (vedi ECONOMICS §7 per l'impatto sul codice)

## Contesto

Il modello B (ADR-006) paga ogni tratta in proporzione ai km di avvicinamento:
il €/km è uniforme, quindi **finire il viaggio non rende più che iniziarlo**.
Ma l'ultima tratta è quella che produce il valore per l'utente (la consegna) e
l'hub di destinazione è l'unico che lavora (giacenza + consegna al
destinatario) senza guadagnare da una tratta in uscita. Decisione utente:
introdurre un incentivo esplicito a **concludere** il percorso.

## Decisione

1. **Il 10% di tutto ciò che il mittente si impegna a pagare** (offerta `P` e,
   coerentemente, ogni boost `ΔP`) è scorporato come **premio di
   finalizzazione** `Π`. Tutti gli altri compensi (lordi progress-based,
   fee degli hub, compensazione di annullamento) si calcolano sul **pool di
   lavoro** = 90% — il premio è escluso da ogni altra formula.
2. **Ripartizione del premio**: 70% al **vettore che consegna** (chi fa il
   check-in all'hub di destinazione), 30% all'**hub di destinazione**.
   Equivalente: 7% e 3% dell'impegno totale del mittente.
3. **Momenti di pagamento** (deterministici, ADR-012):
   - la quota vettore (`Π_v`) viaggia **dentro la hold del pagamento della
     tratta finale** (importo = lordo tratta + `Π_v`): stesse condizioni,
     stesso incasso al `leg_checkin` a destinazione. Una tratta è "finale"
     quando il suo hub di arrivo è l'hub di destinazione — noto
     all'accettazione, quindi il premio è visibile in bacheca nel netto.
   - la quota hub (`Π_h`) è una **quarta hold** mittente→hub di destinazione
     (`purpose: finalization_bonus`), creata nella stessa finestra di funding
     della tratta finale e **rilasciata al `recipient_pickup`**: l'hub è
     premiato per aver completato la consegna, non per aver ricevuto il pacco.
4. **Le fee degli hub non toccano il premio**: si applicano al solo lordo
   progress-based della tratta (il premio "escluso da tutti gli altri
   compensi" vale in entrambe le direzioni).
5. **Ogni quota si consuma al più una volta**:
   - `Π_v` è pagata al primo `leg_checkin` a destinazione. Se dopo
     l'arrivo il mittente fa `reroute`, le eventuali nuove tratte finali non
     hanno quota vettore (il premio è stato guadagnato da chi ha consegnato
     alla destinazione allora richiesta): il costo del ripensamento è del
     mittente, come per il boost.
   - `Π_h` segue il pacco: la hold è annullata se la giacenza finale scade
     (`storage_expiry` → l'hub è compensato dal pacco svincolato, ToS) o se
     il mittente fa `reroute` dallo stato di consegna; una nuova tratta
     finale crea una nuova hold `Π_h` verso il nuovo hub di destinazione.
   - se la tratta finale fallisce (`pickup_timeout`, `transit_timeout`,
     `leg_return`, finestra di funding scaduta) entrambe le quote tornano
     al mittente insieme alle altre hold: il premio resta disponibile per
     la prossima tratta finale.
6. **Boost**: ogni `ΔP` si divide allo stesso modo (90% al pool con decadimento
   proporzionale — ECONOMICS §6; 10% al premio, ripartito 70/30 sulle quote
   non ancora consumate; un boost successivo alla consegna... non esiste:
   il boost richiede pacco fermo non consegnato, e dopo `recipient_pickup`
   la spedizione è chiusa).
7. **Costanti** (in `@mercurio/shared`): `FINALIZATION_BONUS_BP = 1000`
   (10% dell'impegno), `FINALIZATION_CARRIER_SHARE_BP = 7000` /
   `FINALIZATION_HUB_SHARE_BP = 3000` (quote del premio). Arrotondamenti come
   sempre per difetto al sat; `Π_v = floor(Π × 70%)`, `Π_h = Π − Π_v`? No:
   entrambe floor al sat, il resto (< 2 sat) resta al mittente come impegno
   non speso — identico alla scala di ECONOMICS §6.

## Esempio canonico aggiornato (P = 5,00 €, D = 100 km, hub al 10%)

Premio `Π = 0,50 €` (vettore 0,35 / hub finale 0,15); pool di lavoro 4,50 €.

| Voce                              | Calcolo                             | Importo    |
| --------------------------------- | ----------------------------------- | ---------- |
| Luca (40 km): lordo               | 4,50 × 40/100                       | 1,80       |
| Luca: netto                       | 1,80 × (1 − 10% − 10%)              | **1,44**   |
| Hub origine / hub C (tratta 1)    | 10% × 1,80 ciascuno                 | 0,18+0,18  |
| Vettore finale (60 km): lordo     | 4,50 × 60/100                       | 2,70       |
| Vettore finale: netto             | 2,70 × 0,8 **+ 0,35** (premio)      | **2,51**   |
| Hub C (partenza tratta 2)         | 10% × 2,70                          | 0,27       |
| Hub destinazione                  | 10% × 2,70 **+ 0,15** (premio)      | **0,42**   |
| **Totale**                        | 1,80 + 2,70 + 0,50                  | **5,00** ✓ |

Il €/km netto non è più uniforme: 0,036 per Luca, ~0,042 per chi consegna —
la pendenza è l'incentivo voluto. Con tratta unica il vettore netta
4,50 × 0,8 + 0,35 = **3,95 €** (79%) e l'hub di destinazione 0,60 €.

## Conseguenze

- **Conservazione invariata**: `Σ lordi ≤ 90% × (P + Σ boost)` e
  `Σ premi pagati ≤ 10% × (P + Σ boost)`; il totale a carico del mittente
  resta `≤ P + Σ boost`. Ogni quota del premio o si regola verso il
  beneficiario fissato o torna al mittente (invariante 2 di ARCHITECTURE §5).
- **Quarta hold nella finestra di funding della tratta finale**: il mittente
  paga due hold (pagamento tratta + premio hub); `LEG_BOOKED` richiede
  tutte e quattro _held_. Il lock della hold `Π_h` dura fino al ritiro
  (transito + giacenza ≤ 7 giorni: stesso budget CLTV del bond hub, ESCROW §4).
- **Ultimo miglio più appetibile**: si somma alle valvole di ECONOMICS §5
  (boost, reroute) riducendo il "last mile starvation" residuo del modello B.
- **La bacheca cambia**: il netto mostrato per una tratta finale include
  `Π_v`; il matching usa il netto comprensivo di premio nel surplus
  (MATCHING §2) — l'hub di destinazione diventa sistematicamente più
  attraente come hub di consegna, che è esattamente l'obiettivo.
- **Trade-off dichiarato**: a parità di offerta, le tratte intermedie rendono
  il 10% in meno di prima; l'offerta consigliata al mittente (MATCHING §5)
  si ricalibra da sola perché osserva le spedizioni consegnate.

## Alternative considerate

- **Bonus solo al vettore**: non compensa l'asimmetria dell'hub finale
  (una sola tratta adiacente); scartata dalla decisione utente (70/30).
- **Percentuale premio configurabile dal mittente**: più leve = più
  confusione in bacheca; nell'MVP è una costante di protocollo, riesaminabile
  con i dati (come `MAX_HUB_FEE_BP`).
- **Pagare `Π_h` al check-in finale** (insieme al vettore): premierebbe
  l'arrivo, non la consegna; l'hub non avrebbe alcun incentivo economico a
  completare il ritiro del destinatario. Scelto `recipient_pickup`.
