# Mercurio — Motore di matching vettore ↔ spedizioni

> Stato: **implementato** — 2026-07-12 (rev. 2: precisazioni implementative in §7,
> emerse durante l'implementazione in `packages/core/src/matching`).
> Distanze: [ADR-007](adr/ADR-007-haversine-distance.md). Prezzi delle tratte: [ECONOMICS.md](ECONOMICS.md).

## 1. Input

**Il vettore dichiara il viaggio reale** prima di vedere la bacheca (`carrier_trips`):

| Campo                                             | Simbolo    | Esempio                               |
| ------------------------------------------------- | ---------- | ------------------------------------- |
| Partenza (posizione attuale / hub di riferimento) | `O`        | Bologna                               |
| Destinazione del viaggio                          | `Dc`       | Firenze                               |
| Deviazione massima                                | `dev_max`  | 15 km                                 |
| Tariffa minima per km di deviazione               | `rate_min` | 0,20 €/km (suggerita dal sistema, §4) |

**Ogni spedizione in bacheca** (stato `AT_HUB`) porta: hub corrente `S` (con la sua
percentuale `f_S`), hub di destinazione `T`, distanza residua `r_S = d(S, T)`,
distanza totale `D`, pool **di lavoro** residuo contabile
`pool = remainingPool(W, D, r_S, boosts)` (`W` = parte work dell'impegno del
segmento, il 90% dell'ADR-014; i boost entrano con la loro parte work e
decadono proporzionalmente; reroute = nuovo segmento — ECONOMICS §5–6 e
§5-bis), la quota vettore maturata del premio di finalizzazione `Π_v`
(0 se già consumata), bond di custodia richiesto, vincoli fisici (dimensioni,
peso, contenuto non dichiarato sì/no).

## 2. Distanza e deviazione

### Metrica: haversine × fattore di circuità (MVP)

`d(x, y) = haversine(x, y) × k`, con `k = 1.3` (rapporto tipico strada/linea d'aria in
Europa). Scelta motivata in ADR-007, in sintesi:

- **Coerenza interna**: la stessa metrica è usata sia per il **prezzo** della tratta
  (`Δr`, ECONOMICS.md) sia per il **filtro** di deviazione. Gli errori sistematici
  (montagne, laghi) distorcono numeratore e denominatore nella stessa direzione,
  quindi il _rapporto_ convenienza/costo regge meglio del valore assoluto.
- Zero dipendenze esterne, deterministica, gratuita, testabile — giusto per un MVP
  il cui collo di bottiglia è la liquidità di vettori, non la precisione geografica.
- Il costo dell'errore è basso: la deviazione dichiarata è una _preferenza_ del
  vettore, non un vincolo contrattuale; il vettore vede sempre hub e mappa prima
  di accettare.
- Interfaccia `DistanceProvider` in `packages/core`; upgrade futuro a routing reale
  self-hosted (OSRM/Valhalla) senza toccare il dominio. Da fare quando ci saranno
  lamentele reali sulle deviazioni stimate, non prima.

### Deviazione di una tratta

Il vettore parte da `O`, passa dall'hub `S` a ritirare, deposita in un hub candidato
`H`, prosegue verso `Dc`. La deviazione è la strada **in più** rispetto al suo viaggio
diretto:

```
detour(H) = d(O,S) + d(S,H) + d(H,Dc) − d(O,Dc)
```

(Se il vettore è già all'hub `S`, il termine `d(O,S)` è ≈ 0 e la formula si riduce da
sola: nessun caso speciale.)

### Scelta dell'hub di consegna migliore lungo la rotta

Candidati: tutti gli hub `H` (incluso `T` stesso) tali che:

1. `H` accetta il pacco (dimensioni, peso, contenuto non dichiarato, capienza, attivo);
2. **progresso positivo e non-banale**: `r_S − d(H,T) ≥ max(5 km, 5% × D)`; la
   consegna diretta a destinazione (`H = T`, progresso `r_S`) è sempre ammessa,
   anche sotto soglia (ECONOMICS.md §6);
3. l'hub ha il wallet connesso e accetta automaticamente di vincolare il bond di
   custodia (hold invoice — ADR-013; accettazione automatica, ARCHITECTURE §4).

Per ogni candidato si calcolano (ECONOMICS.md, modello B — le percentuali degli hub
si applicano al lordo della tratta):

```
gross(H)   = pool × (r_S − d(H,T)) / r_S
net(H)     = gross(H) × (1 − f_S − f_H)      // f_S = fee dell'hub corrente (partenza),
                                             // f_H = fee dell'hub di consegna (anche se H = T)
surplus(H) = net(H) − rate_min × detour(H)   // guadagno oltre la soglia del vettore
```

**Premio di finalizzazione (ADR-014 — implementato)**: `pool` è il pool di
lavoro (90% dell'impegno, ECONOMICS §5-bis) e per il candidato `H = T` il
netto include la quota vettore del premio:
`net(T) = gross(T) × (1 − f_S − f_T) + Π_v`. La consegna diretta a
destinazione diventa sistematicamente più attraente nel ranking — è
l'incentivo voluto, e la bacheca lo mostra come voce separata
(`DropHubOption.finalizationBonusMsat`, "premio consegna").

**Criterio di match** (come da specifica): esiste `H` con

```
detour(H) ≤ dev_max   E   net(H) ≥ rate_min × detour(H)     (cioè surplus(H) ≥ 0)
```

**Hub proposto** `H* = argmax surplus(H)` tra i candidati che rispettano `dev_max`.
Si massimizza il surplus (non il netto): un netto alto con deviazione enorme non è
un buon suggerimento. La UI mostra comunque le 2–3 alternative migliori: il vettore
può preferire un hub diverso (orari, conoscenza del posto) e la scelta resta sua.

### Esempio numerico

Geometria su piano per leggibilità (in produzione: haversine × 1.3), coordinate in km.
Vettore: `O=(0,0)`, `Dc=(100,0)`, viaggio diretto 100 km, `dev_max = 15 km`,
`rate_min = 0,20 €/km`. Spedizione: pool di lavoro del segmento 5,00 €
(`D = 80 km`), hub corrente `S=(30,10)` con `f_S = 10%`, destinazione
`T=(90,10)` con `f_T = 10%`, `r_S = 60 km`, pool residuo `5,00 × 60/80 =
3,75 €`, quota vettore del premio `Π_v = 0,35 €`.

| Candidato                     | `f_H` | progresso | detour  | gross | net (`×(1−f_S−f_H)`, `+Π_v` se `H=T`) | soglia (`rate_min×detour`) | surplus   | esito                       |
| ----------------------------- | ----- | --------- | ------- | ----- | ------------------------------------- | -------------------------- | --------- | --------------------------- |
| `H1=(60,5)`                   | 10%   | 29,6 km   | 2,3 km  | 1,85  | 1,48                                   | 0,46                       | **+1,02** | match                       |
| `T=(90,10)` (consegna finale) | 10%   | 60 km     | 5,7 km  | 3,75  | 3,00 **+ 0,35** = 3,35                 | 1,15                       | **+2,20** | match, `H*`                 |
| `H3=(50,40)`                  | 5%    | 10 km     | 31,7 km | —     | —                                      | —                          | —         | escluso: `detour > dev_max` |

La consegna diretta a destinazione vince (surplus massimo, allargato dal
premio): è l'esito desiderato quando la destinazione è quasi sulla rotta del
vettore. `H1` resta visibile come alternativa.

## 3. Bacheca: ordinamento

La bacheca dell'hub mostra tutte le spedizioni in stato `AT_HUB` presso quell'hub
(e, in una vista "lungo il tuo viaggio", quelle negli hub vicini alla rotta).
**Esclusioni**: le spedizioni con una tratta in corso (pendente, prenotata o in
transito) e quelle con un **claim del destinatario vivo** (pendente o `CLAIMED`
— [ADR-016](adr/ADR-016-recipient-claim.md)): dalla richiesta di claim il pacco
sparisce dalla bacheca e ogni `leg_accept` è respinto; se la finestra di
funding del claim scade, il pacco ricompare.

1. **Sezione "Per te" (match)**: spedizioni con `surplus(H*) ≥ 0` e `detour(H*) ≤ dev_max`,
   evidenziate, ordinate per `surplus(H*)` **decrescente**.
2. **Sezione "Altre"**: le restanti, ordinate anch'esse per `surplus(H*)` decrescente
   (surplus negativo = quanto manca alla convenienza: le meno peggio prima). Restano
   visibili perché la tariffa minima è una preferenza: il vettore può accettare comunque.

Ogni card mostra: netto in sats (+ € indicativo), deviazione stimata, hub di consegna
proposto `H*` con alternative, bond richiesto, dimensioni/peso, rating del mittente e
degli hub coinvolti. Il netto mostrato è quello **congelato all'accettazione**: nessuna
sorpresa dopo.

Complessità: `O(spedizioni × hub)` a richiesta — irrilevante ai volumi MVP. Quando
servirà: indice spaziale (PostGIS) e pre-filtro dei candidati con bounding box
sull'ellisse `d(O,H) + d(H,Dc) ≤ d(O,Dc) + dev_max`.

## 4. Tariffa suggerita (€/km di deviazione)

Obiettivo della specifica: proporre una "media al ribasso" di ciò che i vettori hanno
**effettivamente accettato**, per ancorare le aspettative verso il basso senza
strangolare l'offerta.

```
input:  rate_observations = tariffe implicite delle tratte accettate
        rate_eff = net_msat / detour_km       (al momento dell'accettazione, in €
                                               al cambio della spedizione)
finestra: ultimi 90 giorni
filtro:   detour_km ≥ 1 (sotto, il rapporto esplode e non significa nulla)

se count(osservazioni) ≥ 30:
    suggerita = percentile_25(rate_eff)            # "media al ribasso" = p25
altrimenti:
    suggerita = DEFAULT_RATE                       # cold start
clamp finale: [0,05 , 1,00] €/km
```

- **p25 e non la media**: robusto agli outlier (tratte accettate "per amicizia" o per
  surplus enorme) e strutturalmente al ribasso, come richiesto. Parametro configurabile.
- **Cold start**: `DEFAULT_RATE = 0,20 €/km` — ordine di grandezza del costo marginale
  chilometrico di un'auto (carburante + usura, tabelle ACI ~0,15–0,25 €/km per utilitarie).
  È un default, non un vincolo: il campo è libero.
- **Anti-manipolazione**: si osservano solo tratte _accettate e poi completate_ (una
  campagna di accettazioni fasulle costa bond e tempo); minimo 30 osservazioni prima
  di abbandonare il default; in futuro bucket per area geografica quando i volumi lo
  giustificano.
- La tariffa suggerita è mostrata al vettore alla dichiarazione del viaggio con
  copy esplicito ("i vettori nella tua zona hanno accettato in media…").

## 5. Offerta consigliata al mittente

Speculare alla tariffa del vettore, ma dal lato opposto del mercato: al mittente che
compila la spedizione il sistema propone **un'offerta che consegna**, non un ribasso.
L'offerta resta **libera** (decisione utente): più si offre, più cresce il surplus di
ogni tratta e più in alto la spedizione compare nella bacheca di _tutti_ i vettori
(§3) — l'urgenza si compra alzando l'offerta, un'asta implicita senza meccanica
d'asta.

```
input:  spedizioni CONSEGNATE negli ultimi 90 giorni
        rate_route = P / D                  (€ per km di rotta, al cambio di ciascuna)

se count(osservazioni) ≥ 30:
    consigliata = D × percentile_50(rate_route)     # mediana: prezzo che ha consegnato
altrimenti:
    consigliata = D × 0,05 €/km                     # cold start: 5 € per 100 km (esempio canonico)
minimo: 2,00 €
```

- **p50 e non p25**: l'asimmetria è voluta. Al vettore si suggerisce il ribasso
  (tira giù le pretese), al mittente il prezzo mediano che ha storicamente portato
  a consegna: suggerire il ribasso anche qui produrrebbe spedizioni che nessuno
  accetta e sfiducia al primo utilizzo.
- Solo spedizioni **consegnate** nel campione: un'offerta pubblicata ma mai
  raccolta non è un prezzo, è un desiderio.
- La UI mostra la forbice ("spedizioni simili sono state consegnate tra X e Y €;
  offri di più per avere priorità") e, dopo la pubblicazione, il **boost**
  (ECONOMICS §5) resta la leva se il pacco ristagna.

## 6. Interfacce (packages/core)

Implementate in `@mercurio/core` (`packages/core/src/matching`); i tipi di
input/output e le costanti sono in `@mercurio/shared` (`matching.ts`), come per
il motore economico.

```ts
export interface DistanceProvider {
  /** Road-distance estimate in km. MVP: haversine × 1.3. Future: OSRM. */
  distanceKm(a: GeoPoint, b: GeoPoint): number;
}
/** Il provider di produzione (ADR-007); k riconfigurabile sui dati veri. */
export function createHaversineDistanceProvider(circuityFactor = 1.3): DistanceProvider;

export interface DropHubOption {
  hubId: string;
  detourKm: number; // quantizzata al metro
  netMsat: bigint; // include il premio consegna quando H = T (ADR-014)
  finalizationBonusMsat: bigint; // la voce "premio consegna" per la UI; 0 se H ≠ T
  surplusMsat: bigint;
}

export interface MatchCandidate {
  shipmentId: string;
  bestDropHub: DropHubOption; // H*
  alternatives: DropHubOption[]; // max 3, surplus decrescente
  isMatch: boolean; // detour(H*) ≤ dev_max && surplus(H*) ≥ 0
}

/** Pure function: (trip, shipments-at-hubs, hubs, provider) → ranked board. */
export function rankBoard(
  trip: CarrierTrip,
  shipments: ShipmentAtHub[],
  hubs: MatchingHub[],
  distance: DistanceProvider,
): MatchCandidate[];

/** §4: p25 dei rate effettivi accettati (90 gg, ≥ 30 oss., detour ≥ 1 km). */
export function suggestCarrierRateEurPerKm(
  observations: CarrierRateObservation[],
  now: Date,
): number;

/** §5: routeKm × p50 di P/D delle spedizioni consegnate; minimo 2 €. */
export function suggestSenderOfferEur(
  routeKm: number,
  observations: DeliveredShipmentObservation[],
  now: Date,
): number;
```

Funzione pura: testabile con scenari geometrici sintetici (come l'esempio §2) e
proprietà (mai suggerire hub con progresso ≤ soglia; surplus coerente con ECONOMICS).

## 8. Mappa del viaggio e export Google Maps (ADR-015 — implementato, dati + UI)

La vista viaggio del vettore mostra una **mappa** (Leaflet + tile OSM, niente
API key — implementata in `apps/web`, `/carrier/trips/:id/route`) con partenza `O`,
destinazione `Dc`, gli hub di ritiro/consegna delle tratte accettate (e in
anteprima quelli della tratta selezionata in bacheca) e la polilinea
dell'itinerario nell'**ordine di visita più breve** che rispetta il vincolo
ritiro-prima-di-consegna per ogni spedizione:

```ts
/** Shortest open path O → … → Dc visiting all stops, pickup before drop
 *  per shipment. Exact search — MAX_ROUTE_WAYPOINTS = 9 (Google URL limit). */
export function orderRouteWaypoints(
  origin: GeoPoint,
  destination: GeoPoint,
  stops: RouteStop[], // { hubId, point, kind: 'pickup' | 'drop', shipmentId }
  distance: DistanceProvider,
): RouteStop[];
```

Implementata in `@mercurio/core` (`matching/route.ts`): ricerca esatta (DP su
sottoinsiemi) su distanze quantizzate al metro, testata contro il brute force
e con property su precedenze e stabilità. L'API la espone con
**`GET /trips/:id/route`**: tappe ordinate delle tratte accettate del viaggio
(una tratta già ritirata contribuisce solo la consegna), anteprima opzionale
di una spedizione della bacheca (`previewShipmentId` + `previewDropHubId`),
tappe oltre il tetto in `unroutedStops` (raggruppate per spedizione, da
mostrare in lista) e l'URL già pronta del bottone **"Apri in Google Maps"**:
`https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=lat,lng|…&travelmode=driving`
con le tappe in quell'ordine — il routing stradale vero lo fa Google al click
(nessun dato inviato prima dell'azione esplicita dell'utente). Dettagli,
alternative scartate e precisazioni implementative in
[ADR-015](adr/ADR-015-carrier-route-map.md).

## 7. Precisazioni implementative (rev. 2 — `packages/core/src/matching`)

Decisioni minori prese durante l'implementazione, tutte nella direzione della
soluzione più semplice coerente con questo documento:

1. **Fallback di `H*` fuori `dev_max`.** `H*` è l'argmax del surplus tra i
   candidati con `detour ≤ dev_max`; se nessun candidato rispetta `dev_max`,
   la card propone comunque il miglior candidato assoluto (con `isMatch =
   false`): la sezione "Altre" deve mostrare qualcosa di sensato, e il vettore
   vede esattamente cosa costerebbe accettare. Le 2–3 alternative provengono
   dallo stesso insieme usato per scegliere `H*` (quindi mai hub oltre
   `dev_max` quando almeno uno lo rispetta — coerente con l'esempio §2, dove
   `H3` è "escluso" e non compare tra le alternative).
2. **Spedizioni senza candidati**: omesse dalla bacheca restituita (l'interfaccia
   richiede un `bestDropHub`); lo stesso vale, difensivamente, per righe
   malformate (hub corrente o destinazione assenti dall'elenco, `r_S` fuori da
   `(0, D]`) e per gli hub con fee oltre il tetto di validazione, che si
   auto-escludono senza far fallire l'intera bacheca.
3. **Quantizzazione**: come nel motore economico, le distanze float del provider
   sono quantizzate al metro intero prima di qualsiasi calcolo monetario;
   `netMsat` è esattamente il `priceLeg(...).netMsat` che verrebbe congelato
   all'accettazione (stesso arrotondamento, nessuna sorpresa dopo); la soglia
   `rate_min × detour` è aritmetica intera `msat/km × metri / 1000` (floor,
   a favore del vettore per < 1 msat).
4. **Vincoli fisici**: il confronto dimensioni ammette la rotazione del pacco
   (si confrontano le terne ordinate); il vincolo wallet+bond (condizione 3 di
   §2) è modellato con i flag `walletConnected` e `autoAcceptDeposits` dell'hub.
5. **Determinismo**: ordinamenti totali con tie-break espliciti — opzioni per
   (surplus ↓, detour ↑, hubId), bacheca per (match prima, surplus(H*) ↓,
   shipmentId). Rimescolare gli input non cambia l'output (property test).
6. **Suggeritori in EUR float**: producono suggerimenti da mostrare accanto a
   campi liberi, non movimenti di denaro (che restano bigint msat, ADR-008);
   ogni osservazione è convertita al **proprio** cambio congelato. Percentile
   con interpolazione lineare (convenzione numpy). Nel rate del mittente
   (`P/D`) i boost sono esclusi: la formula del §5 usa l'offerta `P`.
7. **Premio di finalizzazione (ADR-014)**: `ShipmentAtHub.carrierBonusMsat` è
   la quota vettore maturata (l'API passa 0 quando è stata consumata da un
   arrivo precedente); `priceLeg` la congela solo per `H = T`, il netto
   mostrato e il surplus la includono, e `finalizationBonusMsat` resta
   esposta come voce separata sulla card. Una riga con quota negativa è
   malformata e viene scartata come le altre (precisazione 2).
