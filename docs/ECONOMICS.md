# Mercurio — Motore economico multi-tratta

> Stato: **implementato** — 2026-07-12 (rev. 2: le percentuali degli hub si
> applicano al lordo della tratta del vettore, non all'offerta totale — decisione utente;
> rev. 3: precisazioni implementative in §6, emerse durante l'implementazione in
> `packages/core`; rev. 4 del 2026-07-13: **premio di finalizzazione** in §5-bis,
> [ADR-014](adr/ADR-014-finalization-bonus.md) — decisione utente; rev. 5, stesso
> giorno: ADR-014 **implementato** in `packages/core` — i numeri di §3–§4
> descrivono il riparto del **pool di lavoro**, cioè il 90% dell'impegno del
> mittente; lo scorporo è documentato in §5-bis e ADR-014; rev. 6, stesso
> giorno: precisazione §6.2 sul reroute dallo stato di consegna, emersa
> implementando l'API del ciclo di vita; rev. 7, stesso giorno: **ritiro
> anticipato del destinatario** in §5-ter,
> [ADR-016](adr/ADR-016-recipient-claim.md) — decisione utente, implementata).
> Decisione formalizzata in [ADR-006](adr/ADR-006-progress-based-economics.md).

## 1. Il problema

Il CLAUDE.md dà un esempio a percentuali fisse: vettore 60%, hub di partenza 10%,
hub di arrivo 10%. **Chiarimento di specifica**: le percentuali degli hub sono
calcolate su ciò che guadagna il vettore per la tratta, non sull'offerta del
mittente. Restano però due cose che l'esempio non definisce:

1. **Quanto vale una tratta parziale.** Luca porta il pacco solo per 40 km su 100:
   il "60%" fisso per tratta, qualunque distanza copra, non lega il compenso al
   lavoro fatto e non dice cosa resta per le tratte successive.
2. **Il numero di tratte e di hub intermedi non è noto alla creazione**, quindi il
   modello deve funzionare per qualunque scomposizione del viaggio.

Sotto: notazione, tre modelli, simulazioni numeriche e raccomandazione.

## 2. Notazione

| Simbolo | Significato                                                                         | Esempio canonico         |
| ------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `P`     | Offerta del mittente (pool totale delle tratte)                                     | 5,00 €                   |
| `D`     | Distanza hub origine → hub destinazione (congelata alla creazione)                  | 100 km                   |
| `f_h`   | Percentuale configurata dall'hub `h`, applicata al **lordo delle tratte adiacenti** | 10%                      |
| `r`     | Distanza residua del pacco dalla destinazione                                       | parte da `D`, arriva a 0 |
| `Δr`    | Avvicinamento prodotto da una tratta = `r_prima − r_dopo`                           | —                        |

Ogni tratta ha un hub di partenza e un hub di arrivo: **entrambi prelevano la loro
percentuale dal lordo della tratta**, il vettore incassa il resto. L'hub di origine
della spedizione guadagna solo dalla prima tratta (come hub di partenza), quello di
destinazione solo dall'ultima (come hub di arrivo), gli hub intermedi da due tratte
(arrivo della precedente + partenza della successiva).

`P` è un **impegno di spesa**, non un fondo prefinanziato: si paga tratta per tratta
con hold invoice dirette mittente→vettore (ADR-013). Tutti i calcoli reali sono in
**msat** sul valore in sats congelato alla creazione (ADR-008); qui si usano € per
leggibilità. Le distanze sono quelle del
`DistanceProvider` (haversine × 1.3, ADR-007): la stessa metrica per prezzo e
matching, così le distorsioni si annullano a vicenda.

## 3. I tre modelli

In tutti e tre gli hub prendono la percentuale dal lordo del vettore; i modelli
differiscono su **come si calcola il lordo della tratta**.

### Modello A — Percentuale fissa sul pool residuo

Ogni vettore ha un lordo pari al 60% (configurabile) del pool residuo, qualunque
distanza copra. È la lettura più fedele dell'esempio del CLAUDE.md.

Formale: pool iniziale `R₀ = P`. Alla tratta _i_: `lordoᵢ = 60% × Rᵢ`;
hub di partenza e arrivo prelevano `f × lordoᵢ` ciascuno; `Rᵢ₊₁ = Rᵢ − lordoᵢ`.

### Modello B — Quota proporzionale ai km di avvicinamento (progress-based)

Il pool `P` è ripartito tra le tratte in proporzione all'avvicinamento alla
destinazione:

```
lordo tratta       = pool_residuo × Δr / r        (senza boost equivale a P × Δr / D)
fee hub partenza   = f_dep × lordo
fee hub arrivo     = f_arr × lordo
netto vettore      = lordo × (1 − f_dep − f_arr)
```

Il pool residuo dopo la tratta è `P × r_dopo / D` (+ eventuali boost, §5): si
conserva per costruzione. Le fee dei due hub sono a carico del vettore della
tratta: quella di arrivo la governa lui (sceglie dove depositare), quella di
partenza è nota in bacheca prima di accettare — in ogni caso vede il **netto**
prima di impegnarsi.

**Proprietà notevole**: se tutti gli hub chiedono la stessa `f`, gli hub nel loro
insieme prendono esattamente `2f × P` — comunque venga spezzato il viaggio, perché
la somma dei lordi è sempre `P`. Aggiungere hub intermedi non erode il budget: gli
hub si dividono la stessa torta. (Con percentuali calcolate su `P`, invece, ogni
hub in più costerebbe un'intera fee aggiuntiva.)

### Modello C — Offerta negoziata per tratta (asta)

Ogni tratta è un annuncio: i vettori propongono un prezzo (o accettano un prezzo
esposto), il sistema aggiudica. Il budget `P` è un tetto complessivo. Gli hub
prelevano le percentuali dal lordo aggiudicato.

## 4. Simulazioni — spedizione da 5,00 €, D = 100 km

### Caso 1 — tratta unica (A→B diretta), hub al 10%

|                            | Modello A         | Modello B                 | Modello C               |
| -------------------------- | ----------------- | ------------------------- | ----------------------- |
| Lordo vettore (100 km)     | 60% × 5,00 = 3,00 | 5,00 × 100/100 = **5,00** | prezzo d'asta, es. 4,20 |
| Hub origine / destinazione | 0,30 / 0,30       | **0,50 / 0,50**           | 0,42 / 0,42             |
| Netto vettore              | 2,40              | **4,00** (80%)            | 3,36                    |
| Non assegnato              | **2,00** (†)      | 0                         | 0,80 (†)                |

† Modello A e C devono anche decidere cosa fare dell'avanzo (rimborso? carry-over?):
un'ambiguità in più da progettare.

### Caso 2 — due tratte (l'esempio canonico: A→C 40 km, C→B 60 km, hub al 10%)

**Modello A** (lordo = 60% del residuo):

| Voce                     | Calcolo                              | Importo     | netto €/km |
| ------------------------ | ------------------------------------ | ----------- | ---------- |
| Luca, lordo (40 km)      | 60% × 5,00 = 3,00 → netto 3,00 × 0,8 | **2,40**    | 0,060      |
| Hub origine / C (arrivo) | 10% × 3,00 ciascuno                  | 0,30 / 0,30 |            |
| Pool residuo per 60 km   | 5,00 − 3,00 = 2,00                   |             |            |
| Vettore 2, lordo (60 km) | 60% × 2,00 = 1,20 → netto 1,20 × 0,8 | **0,96**    | 0,016      |
| Hub C (partenza) / dest  | 10% × 1,20 ciascuno                  | 0,12 / 0,12 |            |
| Non assegnato            |                                      | **0,80**    |            |

Il vettore 2 guadagna **quasi 4 volte meno al km** pur facendo più strada, e 0,80 €
restano senza destinazione. Peggio: il lordo non dipende dai km, quindi la strategia
ottima è accettare e depositare all'hub utile più vicino — 60% del pool per 5 km.

**Modello B**:

| Voce                                     | Calcolo                      | Importo    | netto €/km |
| ---------------------------------------- | ---------------------------- | ---------- | ---------- |
| Luca: lordo 5,00 × 40/100 = 2,00         | netto 2,00 × (1 − 10% − 10%) | **1,60**   | 0,040      |
| Hub origine (partenza tratta 1)          | 10% × 2,00                   | 0,20       |            |
| Hub C (arrivo tratta 1)                  | 10% × 2,00                   | 0,20       |            |
| Vettore 2: lordo 5,00 × 60/100 = 3,00    | netto 3,00 × 0,8             | **2,40**   | 0,040      |
| Hub C (partenza tratta 2)                | 10% × 3,00                   | 0,30       |            |
| Hub destinazione (arrivo tratta 2)       | 10% × 3,00                   | 0,30       |            |
| **Totale** (hub C incassa 0,50 in tutto) |                              | **5,00** ✓ |            |

A parità di fee hub il **€/km netto è uniforme** (0,040) per tutti i vettori del
viaggio: nessuna tratta è strutturalmente svantaggiata.

### Caso 3 — tre tratte con percentuali hub diverse (30 + 40 + 30 km; origine e dest 10%, H1 10%, H2 20%)

**Modello B**:

| Tratta        | Lordo              | Fee partenza | Fee arrivo                | Netto vettore | netto €/km     |
| ------------- | ------------------ | ------------ | ------------------------- | ------------- | -------------- |
| A→H1 (30 km)  | 5,00 × 0,30 = 1,50 | origine 0,15 | H1 0,15                   | **1,20**      | 0,040          |
| H1→H2 (40 km) | 5,00 × 0,40 = 2,00 | H1 0,20      | H2 0,40                   | **1,40**      | 0,035          |
| H2→B (30 km)  | 5,00 × 0,30 = 1,50 | H2 0,30      | dest 0,15                 | **1,05**      | 0,035          |
| Totali        | 5,00               |              | hub: 1,35 · vettori: 3,65 |               | **Σ = 5,00** ✓ |

L'hub H2 al 20% morde il netto di _entrambe_ le tratte adiacenti: il matching
(netto ≥ tariffa minima × deviazione, MATCHING.md) tenderà a scartarlo se esiste
un'alternativa → **pressione competitiva sulle percentuali degli hub**, che è
l'incentivo giusto. Si noti anche che il guadagno di un hub cresce con il lordo
delle tratte adiacenti (cioè con i km serviti), non è fisso per pacco: un hub che
abilita tratte lunghe guadagna di più.

**Modello A, stesse tratte**: lordi 3,00 → 1,20 → 0,48 (decadimento geometrico:
ogni tratta vale il 40% della precedente, _indipendentemente dai km_), netti
2,40 → 0,96 → 0,38, più 0,32 non assegnati. La terza tratta rende 0,013 €/km:
nessuno la accetta, il pacco si incaglia vicino alla meta ("last mile starvation").

### Confronto degli incentivi

| Criterio                                  | A — % fissa sul residuo                 | B — proporzionale ai km                               | C — asta per tratta                         |
| ----------------------------------------- | --------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| Budget distribuito per intero             | ✗ resta sempre un residuo non assegnato | ✓ esatto per costruzione                              | ~ dipende dalle aste                        |
| Ultima tratta finanziabile                | ✗ decadimento geometrico                | ✓ vale sempre `P × r/D`                               | ~ a rischio se le prime aste chiudono alte  |
| Incentivo a frammentare                   | ✗✗ 60% del pool anche per 1 km          | ✓ neutro (lineare); frammentare aggiunge solo fee hub | ~ dipende                                   |
| Pressione sulle fee hub                   | ~                                       | ✓ le fee mordono il netto e il vettore sceglie        | ✓                                           |
| Prevedibilità per il mittente             | ✗                                       | ✓ costo totale = `P`, sempre                          | ✗ tempi e esito incerti                     |
| Efficienza di prezzo (tratte "difficili") | ✗                                       | ~ €/km uniforme anche dove il mercato vorrebbe premi  | ✓ price discovery vero                      |
| Complessità UX/implementativa             | bassa                                   | bassa                                                 | alta (bid, timeout, top-up, aggiudicazione) |

## 5. Raccomandazione: Modello B, con due valvole di sfogo

**Modello B (proporzionale ai km di avvicinamento)** per l'MVP, perché è l'unico dei
tre che distribuisce sempre l'intero budget fino a destinazione, non premia la
frammentazione, mette in concorrenza le fee degli hub ed è spiegabile in una riga:
_"guadagni in proporzione a quanto avvicini il pacco; gli hub trattengono la loro
percentuale dal lordo della tua tratta"_.

Il suo limite — €/km uniforme anche dove il mercato vorrebbe premi (ultimo miglio
rurale) — è mitigato da tre meccanismi:

1. **Boost del mittente**: in qualunque momento a pacco fermo (e la UI lo propone se
   ristagna oltre una soglia, es. 48h), il mittente può aumentare l'offerta di `ΔP`,
   che si somma al pool residuo nel momento del boost: `pool = P × r_b/D + ΔP` alla
   distanza residua `r_b`, ripartito sui km rimanenti (`lordo = pool × Δr/r`). Da lì
   in poi il boost si consuma **in proporzione ai km come il resto del pool**: alla
   distanza `r < r_b` contribuisce `ΔP × r/r_b` (vedi §6 — se restasse costante,
   spezzare le tratte dopo un boost pagherebbe in totale più di `P + ΔP`). Non
   richiede alcun pagamento immediato — l'impegno si paga tratta per tratta
   (ADR-013); nessun ricalcolo delle tratte già pagate.
2. **Reroute del mittente**: a pacco fermo (nessuna tratta prenotata) può cambiare
   l'hub di destinazione e/o il destinatario — es. il pacco è finito in un paesino
   poco battuto e conviene spostare la consegna su un hub lungo una direttrice, o
   richiamarlo verso l'origine. Il pool residuo resta quello che è e si ripartisce
   sulla nuova distanza residua `r'` (`lordo = pool × Δr/r'`): la formula è già
   generale, niente ricalcoli delle tratte pagate. Operativamente il reroute apre un
   **nuovo segmento di prezzo** (§6): il pool corrente — boost inclusi — viene
   congelato come nuovo impegno `P*` e la nuova distanza `r'` fa da nuovo `D*`; i
   boost successivi si riferiscono al segmento corrente. Boost e reroute si combinano
   (dallo stato di consegna, a pool esaurito, il reroute _richiede_ un boost).
3. **Il matching protegge il vettore**: nessuno è mai indotto ad accettare in perdita,
   perché la bacheca mostra il **netto** e il criterio di match esige
   `netto ≥ tariffa_minima × km di deviazione` (MATCHING.md).

## 5-bis. Premio di finalizzazione (ADR-014 — implementato)

Decisione utente (2026-07-13): il modello B paga il progresso ma non premia la
**conclusione**. Correttivo: il **10% di tutto ciò che il mittente si impegna a
pagare** (offerta `P` + ogni boost) è scorporato come premio `Π`, ripartito
**70% al vettore che consegna** (check-in all'hub di destinazione) e **30%
all'hub di destinazione** (rilasciato al ritiro del destinatario). Tutte le
formule di questo documento operano sul **pool di lavoro** = 90% dell'impegno:
lordi, fee hub e compensazione di annullamento **escludono il premio**, in
entrambe le direzioni (il premio non paga fee).

Nel codice: `splitCommitment` (`@mercurio/core/economics`) scorpora ogni
impegno all'ingresso in parte work e quote del premio; `priceLeg` congela la
quota vettore (`LegPricing.finalizationBonusMsat`) sulla sola tratta con
`Δr = r`; la macchina a stati apre la quarta hold `Π_h` e la rilascia al
ritiro (ARCHITECTURE §5). Dettagli e arrotondamenti in ADR-014,
"Precisazioni implementative".

Esempio canonico aggiornato (P = 5,00 €, D = 100 km, hub al 10%,
`Π = 0,50 €` → vettore 0,35 / hub 0,15; pool di lavoro 4,50 €):

| Voce                          | Calcolo                        | Importo    |
| ----------------------------- | ------------------------------ | ---------- |
| Luca (40 km): netto           | 4,50 × 0,40 × 0,8              | **1,44**   |
| Vettore finale (60 km): netto | 4,50 × 0,60 × 0,8 **+ 0,35**   | **2,51**   |
| Hub C (0,18 + 0,27)           | fee sulle due tratte adiacenti | 0,45       |
| Hub origine                   | 10% × 1,80                     | 0,18       |
| Hub destinazione              | 10% × 2,70 **+ 0,15**          | **0,42**   |
| **Totale**                    | 4,50 + 0,50                    | **5,00** ✓ |

Meccanica, momenti di pagamento, edge case (reroute dopo l'arrivo, scadenza
giacenza, boost) e costanti (`FINALIZATION_BONUS_BP = 1000`, quote 70/30) in
[ADR-014](adr/ADR-014-finalization-bonus.md). La conservazione resta:
`Σ lordi ≤ 90% × (P + Σ boost)`, `Σ premi ≤ 10% × (P + Σ boost)`, e ogni quota
del premio o si regola verso il beneficiario fissato ex-ante o torna al
mittente.

Il **Modello C resta la roadmap** (v2) come _overlay_: il prezzo progress-based diventa
il prezzo esposto "accetta subito", con possibilità di controfferte. L'interfaccia dati
(`legs.gross_msat / dep_hub_fee_msat / arr_hub_fee_msat / net_msat` congelati
all'accettazione) è già compatibile.

## 5-ter. Ritiro anticipato del destinatario (ADR-016 — implementato)

Decisione utente (2026-07-13): il destinatario può **reclamare** il pacco
fermo in un qualsiasi hub (stato `AT_HUB`, nessuna tratta in corso) facendo
lui la tratta residua. La formula del claim, congelata alla richiesta con
floor al sat **per parte** (come i congelamenti di tratta):

```
claim payment  = ⌊remainingPool(W, D, r, boosts)⌋ + ⌊Π_v non consumata⌋   (mittente → destinatario)
quota hub      = ⌊Π_h maturata⌋                                           (mittente → hub di ritiro)
fee hub        = nessuna
```

Il destinatario incassa esattamente ciò che la rete avrebbe pagato per
portare il pacco a destinazione da lì: il pool residuo alla distanza corrente
`r` **più la quota vettore del premio** (sta concludendo lui il percorso — il
claim **consuma Π_v**). L'hub di ritiro, che completa la consegna, incassa la
quota hub del premio: esattamente il lavoro che Π_h paga (ADR-014). Nessuna
fee hub: la fee d'arrivo della tratta entrante è già stata pagata sul posto e
resta pagata. Conseguenza documentata: un claim all'hub di **origine** dà
all'hub solo Π_h (nessuna tratta è mai entrata né uscita).

Esempio canonico (P = 5,00 €, D = 100 km, hub al 10%; Luca ha già fatto
A→C, 40 km): Rita reclama a C e incassa `4,50 × 60/100 + 0,35 = `**3,05 €**;
Carla (hub C) incassa Π_h = **0,15 €** oltre alla fee d'arrivo già presa
(0,18 €); Marco ha pagato in tutto 1,80 + 3,05 + 0,15 = **5,00 €** spaccati.

**Conservazione invariata**: il claim liquida il pool residuo alla `r`
corrente, quindi `Σ lordi tratte pagate + claim payment ≤ 90% × (P + Σ
boost)` per costruzione; ogni quota del premio si consuma al più una volta; i
resti di floor restano al mittente. Un claim con pool residuo e Π_v entrambi
a zero è **respinto** (una hold a importo zero non esiste su Lightning): il
mittente deve prima fare `boost`, come per sbloccare qualunque vettore. Nel
codice: `priceClaim` (`@mercurio/core/economics`); meccanica delle hold e
stati in ARCHITECTURE §5 (righe 18–21) e ESCROW §3-bis.

### Regole di contorno

- **Offerta libera, effetto asta implicito**: nessun tetto all'offerta `P`. Alzare
  `P` alza il lordo di _ogni_ tratta e quindi il surplus nel matching: la spedizione
  sale nella bacheca di tutti i vettori (MATCHING §3). L'urgenza si compra offrendo
  di più, senza meccanica d'asta esplicita. Al mittente viene proposto un prezzo
  consigliato basato sulle spedizioni effettivamente consegnate (MATCHING §5).
- **Progresso minimo per tratta**: `Δr ≥ max(5 km, 5% × D)`. Evita micro-tratte che
  moltiplicano i passaggi di mano (ogni passaggio è un rischio). **Eccezione**: la
  tratta che consegna all'hub di destinazione (`Δr = r`) è sempre ammessa, per corta
  che sia — altrimenti un pacco a meno di 5 km dalla meta (es. dopo un reroute) non
  sarebbe mai consegnabile.
- **Solo progresso positivo**: hub di deposito ammessi solo se `r` diminuisce.
  Nessun pagamento per spostamenti laterali o all'indietro.
- **Tetto di validazione sulle fee hub** (`f ≤ 30%`, costante `MAX_HUB_FEE_BP`) e
  vincolo `f_dep + f_arr < 100%` per tratta: sopra certe soglie l'hub non è mai
  conveniente e inquina solo la bacheca. Le percentuali sono trattate come **basis
  point interi** (1 bp = 0,01%), rappresentazione senza perdita della colonna
  `hubs.fee_percent numeric(5,2)`.
- **Compensazione di annullamento**: se il mittente annulla dopo il check-in
  all'hub di origine (nessuna tratta partita), paga `f_o × pool di lavoro del
  segmento` (cioè `f_o × 90% × P` sul primo segmento — ADR-014: il premio è
  escluso anche da questa formula) direttamente all'hub — quanto avrebbe
  guadagnato da una tratta unica; la restituzione del pacco si sblocca al
  pagamento. Alla scadenza di giacenza, invece, il pacco svincolato secondo
  ToS è la compensazione dell'hub (non esiste un escrow prefinanziato —
  ADR-013).
- **Arrotondamenti**: ogni importo (lordi, fee) è arrotondato per difetto al sat al
  momento del congelamento della tratta; non esistono resti da redistribuire perché
  non esiste una pentola comune (la scala completa degli arrotondamenti è in §6).
- **Fee di piattaforma**: 0% nell'MVP. Con l'architettura zero-custodia un'eventuale
  fee futura sarebbe comunque un pagamento diretto separato utente→piattaforma,
  mai una trattenuta su fondi altrui.
- **Cambio EUR/sats**: congelato alla creazione e usato per tutta la vita della spedizione;
  la volatilità del cambio è a carico di chi incassa sats (come per qualunque prezzo
  in sats — Bitcoin Design Guide: importi mai ambigui, mostrare sempre sats + € indicativo).

## 6. Precisazioni implementative (rev. 3 — `packages/core/src/economics`)

Il motore è implementato come funzioni pure in `@mercurio/core` (`priceLeg`,
`remainingPool`, `applyReroute`, `cancellationCompensation`, `minLegProgressKm`,
e dall'ADR-014 `splitCommitment`); i tipi condivisi con l'API (`LegPricing`,
`PoolBoost`, `PoolSegment`) e le costanti sono in `@mercurio/shared`. Con
l'ADR-014 tutte le funzioni del pool operano su importi **work** (il 90%
scorporato da `splitCommitment` all'ingresso di ogni impegno): nelle formule
qui sotto `P` e `ΔP` vanno letti come le rispettive parti work. Tre
precisazioni sono emerse implementando le proprietà di conservazione, e sono
forzate dalle proprietà stesse (non sono scelte libere):

1. **Il boost decade proporzionalmente.** `pool = P × r/D + ΔP` vale nel momento del
   boost (`r = r_b`); da lì in poi il contributo del boost è `ΔP × r/r_b`. Se restasse
   costante, il pool si _gonfierebbe_: spezzando le tratte dopo un boost la somma dei
   lordi supererebbe `P + ΔP` (violazione dell'invariante di conservazione e
   dell'assenza di incentivo a frammentare). Forma chiusa, indipendente da come sono
   state spezzate le tratte passate:
   `pool(r) = P × r/D + Σᵢ ΔPᵢ × r/r_bᵢ` — chiunque può ricalcolare il pool dalla riga
   della spedizione più gli eventi di boost, senza stato accumulato.
2. **Il reroute apre un segmento.** Il pool corrente (boost inclusi) è congelato come
   impegno del nuovo segmento (`P* = pool`, `D* = r'`); i boost successivi sono
   relativi al segmento corrente. Le tratte già pagate non si toccano per costruzione:
   erano prezzate sul pool com'era allora. **Caso limite — reroute dallo stato di
   consegna** (rev. 6, 2026-07-13, emerso implementando l'API): a destinazione la
   distanza residua è 0, quindi il pool decaduto congela a 0 per costruzione; i boost
   fatti col pacco fermo a destinazione però non hanno mai "viaggiato" e la loro parte
   work passa al nuovo segmento **senza decadimento** (`P* = Σ work dei boost
   post-arrivo`). È l'unica lettura che rende vero "il reroute dallo stato di
   consegna a pool esaurito richiede un boost" (§5) senza perdere l'impegno del
   mittente; la conservazione regge perché ogni parte work entra nel pool una volta
   sola.
3. **Scala degli arrotondamenti** (tutti per difetto, mai a favore di chi incassa):
   le distanze sono quantizzate al **metro intero** all'ingresso (così ogni divisione
   è aritmetica bigint esatta e due macchine congelano gli stessi msat); il pool
   nozionale è troncato al **msat**; gli importi congelati (lordo, fee) al **sat**
   (ADR-008). I resti di troncamento restano al mittente come impegno non speso.

Proprietà verificate dai test (fixture esatte al msat sulle simulazioni di §4
e sull'esempio di §5-bis + proprietà su input casuali con PRNG deterministico):
`Σ lordi ≤ 90% × (P + Σ boost)` e `Σ premi pagati ≤ 10% × (P + Σ boost)`
sempre — quindi il mittente non deve mai più di `P + Σ boost`; nessun importo
negativo; `netto + fee = lordo` esatto (il premio resta fuori dall'identità e
non paga fee); spezzare una tratta in due non aumenta mai il totale lordo dei
vettori; a parità di `f` gli hub incassano `2f × W` sul pool di lavoro `W`
(esatto a meno dei floor al sat, con bound documentati nei test).

### Divergenza dichiarata dal CLAUDE.md

Con il Modello B l'esempio canonico cambia: Luca (40 km su 100, hub al 10%) ha un
lordo di 2,00 € e incassa **1,60 € netti**, non 3,00 €. Il "60%" fisso non
sopravvive al multi-tratta; in compenso il vettore che fa la tratta unica completa
netta l'**80%** (4,00 €). L'esempio nel CLAUDE.md è già stato allineato (lordo
`5 € × 40/100 = 2 €`, netto 1,60 €, fee hub calcolate sul lordo del vettore):
nessuna divergenza residua.
