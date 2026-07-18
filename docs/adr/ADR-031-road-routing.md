# ADR-031 — Routing stradale reale: motore delle geometrie e confine col motore dei prezzi

- Stato: **accettato — decisioni di Giacomo 2026-07-18** (§«Le decisioni
  aperte»): **routing anche nel pricing** (contro la raccomandazione
  display-only, registrata sotto per storia), **OSRM self-hosted**, **una
  sola cifra in UI** (la metrica di prezzo). Disegno dell'implementazione in
  §«Il disegno». Fase 4 della revisione UX.
- Contesto: [ADR-007](ADR-007-haversine-distance.md) (haversine × 1.3 e
  l'argomento di coerenza prezzo/filtro), [ADR-015](ADR-015-carrier-route-map.md)
  (mappa del viaggio: polilinee rette, «il routing vero lo fa Google al click»),
  [ADR-030](ADR-030-hub-discovery-scale.md) (mappa /hubs),
  [MATCHING §2](../MATCHING.md) (detour e criterio di match) e §4 (tariffa
  suggerita calibrata sui detour osservati), [ECONOMICS §2–3 e §6](../ECONOMICS.md)
  (il prezzo usa `Δr/r`; `D` congelata alla creazione; determinismo al msat),
  [ADR-024](ADR-024-production-deploy.md)/[DEPLOY](../DEPLOY.md) (un solo VPS,
  2 vCPU / 2 GB: ogni servizio in più si paga).

## Problema

Il backlog della revisione UX chiede: *«proposte ordinate per convenienza su
mappa con il percorso stradale reale (non linee dritte, deviazioni in tonalità
diversa)»*. Oggi la mappa del viaggio (ADR-015) disegna rette tra le tappe e
tutti i numeri — prezzi, detour, surplus, ordinamento della bacheca — vengono
da `DistanceProvider` (haversine × 1.3, ADR-007).

La richiesta nasconde **due domande ortogonali**, e conviene deciderle
separatamente perché hanno costi e rischi diversissimi:

1. **Da dove vengono le geometrie stradali** (il motore): OSRM self-hosted,
   API esterne, o restare alle rette.
2. **Fin dove arriva la nuova metrica** (il confine): solo nella UI
   (*display-only*: polilinee vere sulla mappa, tutti i numeri restano su
   haversine × 1.3) oppure anche in prezzi e matching (*routing nel pricing*).

La (2) è la decisione che conta: tocca il motore dei prezzi, quindi spetta a
Giacomo (regola di CLAUDE.md: nessuna logica di denaro senza decisione
esplicita). «Proposte ordinate per convenienza» resta in ogni caso
l'ordinamento per surplus già implementato (MATCHING §3): questo ADR decide
solo con quale metrica quel surplus è calcolato e cosa disegna la mappa.

## Domanda 1 — Il motore delle geometrie

| Opzione                                  | Pro                                                                                       | Contro                                                                                                                                                     |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. OSRM self-hosted** *(raccomandata)* | Coordinate mai a terzi; gratuito; deterministico a parità di estratto; API `/route` banale; immagine ufficiale BSD-2 | Un container in più sul VPS (ADR-024); preprocessing pesante (fuori dal VPS); aggiornamento mappe manuale                                                     |
| B. Valhalla self-hosted                  | Serve a tile con cache LRU: RAM di esercizio più bassa e prevedibile di OSRM in-RAM        | Superficie di configurazione molto più ampia per l'unico endpoint che ci serve; stessa operatività di A                                                      |
| C. API esterne (Google/Mapbox/ORS cloud) | Zero operatività, mappe sempre fresche                                                     | Coordinate di utenti e hub a terzi (GDPR, contro ADR-007); costi a volume; **ToS Google: le polilinee Directions si mostrano solo su mappe Google** — incompatibile con Leaflet+OSM (ADR-015); il demo server OSRM vieta l'uso in produzione |
| D. Status quo (rette)                    | Zero costi                                                                                 | Non risponde al requisito del backlog                                                                                                                        |

**Raccomandazione: A**, con B come ripiego se le misure di memoria sul VPS
deludessero (stessa interfaccia interna: cambiare motore non tocca nient'altro).
La C è esclusa dagli stessi argomenti dell'ADR-007 (privacy, dipendenza,
spirito self-hostable) più il blocco ToS: la nostra mappa è OSM, e le
geometrie di Google non possono legalmente starci sopra. La D resta il
**fallback strutturale** dell'opzione A (sotto): il router è opzionale, chi
self-hosta senza container OSRM ottiene esattamente il comportamento di oggi.

## Domanda 2 — Il confine: display-only vs routing nel pricing

### Opzione E — Display-only *(raccomandata)*

Le polilinee stradali esistono **solo nella UI** (mappa del viaggio, e in
prospettiva /hubs). Ogni numero — `D`, `r`, `Δr`, detour, surplus, tariffe
suggerite, prezzi congelati — resta su `DistanceProvider` (haversine × 1.3).
L'argomento di coerenza dell'ADR-007 resta intatto alla lettera: prezzo e
filtro condividono la stessa metrica, gli errori sistematici si compensano nei
rapporti, e le calibrazioni di mercato (tariffa suggerita §4, `dev_max` e
`rate_min` dichiarati dai vettori) mantengono la loro unità di misura.

**Confine strutturale, non convenzione**: le geometrie NON passano da
`DistanceProvider`. Vive un'interfaccia separata (un
*route geometry provider* lato API), così il motore economico non può
nemmeno per sbaglio consumare km stradali: `packages/core` non cambia di una
riga, e «display-only» è garantito dal grafo delle dipendenze, non dalla
disciplina.

Costo onesto da dichiarare: la polilinea disegnata avrà una lunghezza reale
diversa (localmente anche ±20–30%) dai km stampati sulle card, che restano
quelli della metrica di prezzo. È la stessa discrepanza che oggi esiste col
bottone «Apri in Google Maps» (ADR-015), resa più visibile. La UI già dice
«deviazione stimata»; la mappa parla di *forma*, le cifre parlano della
metrica che congela i prezzi.

### Opzione F — Routing anche nel pricing

In apparenza è l'upgrade «pulito»: `DistanceProvider` è nato per questo
(ADR-007: «upgrade futuro a routing reale senza toccare il dominio») e se
prezzo E filtro passano entrambi a km stradali la coerenza interna, in regime
stazionario, si conserva. Ma il motore dei prezzi ha tre proprietà che un
router rompe, e l'ADR-007 non le affrontava perché rimandava tutto:

1. **Determinismo e ricalcolabilità.** ECONOMICS §6.3: le distanze sono
   quantizzate al metro proprio perché «due macchine congelano gli stessi
   msat», e la forma chiusa del pool (§6.1) permette a chiunque di ricalcolare
   ogni importo dalla riga della spedizione più gli eventi di boost. L'output
   di un router dipende dallo snapshot OSM e dalla versione del motore: ogni
   aggiornamento mappe cambia i numeri. Per non perdere l'auditabilità di un
   sistema di pagamenti bisognerebbe versionare la metrica per spedizione e
   tenere in vita ogni snapshot usato da una spedizione aperta (o congelare in
   DB ogni distanza intermedia): operatività da archivio cartografico per un
   MVP.

2. **Grandezze congelate contro grandezze ricalcolate.** `D` si congela alla
   creazione; `r_S` si ricalcola a ogni bacheca; il pool residuo è
   `P × r/D`. La compensazione errore-numeratore/denominatore vale solo se
   numeratore e denominatore usano la **stessa** metrica: nel momento in cui
   la metrica cambia sotto una spedizione in volo (switch, aggiornamento
   mappe, fallback), `r` nuovo divide una `D` vecchia. Esempio alpino:
   linea d'aria 77 km ⇒ `D = 100 km` (×1.3); strada vera 123 km (circuità
   locale 1.6). Dopo lo switch `r = 123 > D = 100` ⇒
   `remainingPool = P × 123/100 > P`: la conservazione (`Σ lordi ≤ 90% × P`)
   salta **prima ancora della prima tratta**. Le proprietà verificate dai
   test valgono sotto una metrica fissa per segmento; l'opzione F obbliga a
   congelare la metrica per spedizione (le vecchie restano haversine per
   sempre) e a farla rispettare da bacheca, reroute e claim.

3. **La bacheca non può bloccarsi né mentire.** MATCHING §7.3: il netto
   mostrato sulla card «è esattamente il `priceLeg` che verrebbe congelato
   all'accettazione — nessuna sorpresa dopo». Con un router vivo tra il
   render della card e l'accettazione, un'evizione di cache o un
   aggiornamento mappe può cambiare il numero congelato rispetto a quello
   mostrato. E se il router è giù? Un fallback a haversine **nel pricing** è
   indifendibile (la stessa tratta prezzerebbe diversa a seconda della salute
   di un container); nessun fallback significa bacheca bloccata. Con
   haversine pura il problema non esiste per costruzione. In più la bacheca è
   `O(spedizioni × hub)` valutazioni di distanza: in-process sono
   nanosecondi, via router sono chiamate HTTP (o matrici `/table`) sul
   percorso caldo.

4. **Ridenominazione delle calibrazioni.** La tariffa suggerita è il p25 dei
   `rate_eff = net/detour_km` osservati in 90 giorni (MATCHING §4), e i
   vettori hanno dichiarato `dev_max` e `rate_min` contro i km che il sistema
   mostrava loro. Cambiare metrica è una riforma monetaria: in montagna i
   detour crescono (~+25% rispetto a ×1.3 dove la circuità vera è 1.6), i
   surplus calano a parità di netto, i match spariscono esattamente dove la
   liquidità di vettori è già scarsa — mentre la tariffa suggerita insegue
   con 90 giorni di ritardo. Servirebbe un piano di cutover (solo nuove
   spedizioni, doppio regime in bacheca), non un flip di config.

**Quando avrebbe senso F**: quando i dati reali mostreranno dispute o rinunce
causate da detour stimati male — il trigger che l'ADR-007 stesso fissa
(«lamentele reali, non prima»). E anche allora la prima leva è più piccola:
ricalibrare `k` (è già configurabile), o per-regione. F resta possibile in
futuro dietro la stessa interfaccia, con un ADR dedicato al versionamento
della metrica; niente di ciò che facciamo ora lo preclude.

## Costi operativi OSRM per l'Italia (opzione A)

Ordini di grandezza verificabili, da rimisurare al Task 2:

- **Estratto**: Geofabrik `italy-latest.osm.pbf` ≈ 2 GB.
- **Preprocessing** (pipeline MLD: `osrm-extract` + `osrm-partition` +
  `osrm-customize`): picco RAM ~10–16 GB ⇒ **impossibile sul VPS da 2 GB**.
  Si fa fuori linea (macchina di sviluppo o VM cloud usa-e-getta), una tantum
  e a ogni aggiornamento mappe; sul VPS si copiano solo gli artefatti.
- **Artefatti su disco**: ~5–8 GB (`.osrm.*`), da sommare allo spazio del VPS.
- **RAM di esercizio**: caricamento in RAM ~4–6 GB — non ci sta. Con
  `osrm-routed --mmap` i file sono mappati e la RSS scende a poche centinaia
  di MB, con la page cache a fare il lavoro: è la via per il VPS attuale.
  Se le latenze deludessero: upgrade del VPS a 4 GB (~pochi €/mese) o
  Valhalla (opzione B).
- **Cold start**: secondi con `--mmap` (caricamento pigro); minuti se in RAM.
- **Latenza**: singola `/route` su MLD ~10–50 ms — irrilevante per la mappa,
  e la cache delle geometrie (sotto) rende il carico a regime ~nullo.
- **Aggiornamento mappe**: manuale, trimestrale è già abbondante — per il
  display-only la stalezza è cosmetica (una rotatoria nuova, non un prezzo
  sbagliato). Procedura da documentare in DEPLOY.md.
- **Container**: immagine ufficiale `osrm/osrm-backend`, nel compose di
  produzione dietro un profilo **opzionale**; mai esposto pubblicamente
  (rete di compose, lo chiama solo l'API server-side). L'eccezione al «lo
  stack è Postgres + API + web + proxy, punto» dell'ADR-024 è dichiarata qui.

## Le decisioni aperte (DECISE da Giacomo — 2026-07-18)

### A. Confine: display-only (E) o routing anche nel pricing (F)? → **F** ✅

La raccomandazione era E (display-only); Giacomo ha scelto **F con piena
cognizione dei quattro problemi** elencati sopra, che quindi smettono di
essere obiezioni e diventano **requisiti del disegno**: l'implementazione
deve risolverli, non ignorarli. Come li risolve è in §«Il disegno».

### B. Motore? → **OSRM self-hosted** ✅ (come raccomandato)

Container opzionale, mai esposto pubblicamente; Valhalla resta il ripiego
se le misure di memoria sul VPS deludessero; API esterne escluse
(privacy + ToS); le rette restano il fallback **di sola visualizzazione**.

### C. Cifre in UI? → **Solo la metrica di prezzo** ✅ (come raccomandato)

Una cifra sola, quella che congela i prezzi (che con la decisione A, per le
spedizioni nuove, È la distanza stradale). La polilinea comunica la forma;
«~X km su strada» come annotazione resta un'aggiunta solo-UI possibile poi.

## Il disegno (Task 2 — come F diventa implementabile senza rompere il motore)

I quattro problemi di §Opzione F, uno per uno:

### 1. Metrica congelata per spedizione

Nuova colonna `shipments.distance_metric` (`'haversine' | 'road'`), scelta
**alla creazione** e mai più cambiata: `'road'` se il router risponde in quel
momento (e la coppia origine→destinazione è instradabile), `'haversine'`
altrimenti — per sempre, anche se il router torna su. Le spedizioni esistenti
restano `'haversine'` (default di migrazione). Ogni numero monetario di una
spedizione — `D`, `r`, `Δr`, detour dei candidati, surplus, prezzi congelati
— usa la metrica della spedizione, dalla creazione alla consegna: numeratore
e denominatore non si mischiano mai (problema 2 di §F risolto alla radice:
niente switch in volo, quindi mai `r` nuova su `D` vecchia).

### 2. La verità è il DB, non il router: `road_distances` first-write-wins

Tabella append-only `road_distances`: chiave = coppia **ordinata** di punti
quantizzati (10⁻⁴ gradi ≈ 11 m — coerente con la quantizzazione al metro del
motore, ECONOMICS §6.3; ordinata perché le strade non sono simmetriche),
valore = **metri interi**. Il router si interroga solo su cache miss
(`/route` per coppie singole, `/table` per le matrici di bacheca); una volta
scritta, una riga **non cambia mai** — nemmeno aggiornando le mappe: gli
aggiornamenti migliorano solo le coppie mai viste. Conseguenze volute:

- **Determinismo**: due macchine leggono la stessa riga ⇒ congelano gli
  stessi msat. Il pool resta ricalcolabile da DB (riga spedizione + eventi di
  boost + `road_distances`, che entra nel backup): l'auditabilità di
  ECONOMICS §6 sopravvive senza archivio di snapshot cartografici.
- **Conservazione**: sotto una metrica immutabile per spedizione la
  monotonia di `r` e `Σ lordi ≤ 90% × (P + Σ boost)` valgono per gli stessi
  argomenti di oggi (il progresso minimo garantisce `Δr > 0` nella stessa
  metrica). `D` e `r` vengono dalle stesse righe immutabili.
- **«Nessuna sorpresa dopo»** (MATCHING §7.3): card e congelamento leggono
  le stesse righe ⇒ il netto mostrato è il netto congelato, come oggi.
- Deriva pluriennale dalla realtà stradale: accettata e documentata (una
  variante nuova non cambia i prezzi di coppie già viste — è un pregio per
  un sistema di pagamenti, non un difetto).

### 3. Il motore resta puro e sincrono: pre-risoluzione nell'API

`packages/core` **non cambia**: `DistanceProvider` resta un'interfaccia
sincrona e le funzioni restano pure. È l'API a pre-risolvere (cache →
router) tutte le coppie che serviranno, costruire un provider in-memory
(una `Map` coppia→metri) e solo allora chiamare `rankBoard`/`priceLeg`/
`priceClaim`. La bacheca con metriche miste si calcola **per gruppi**:
`rankBoard(spedizioni haversine, provider haversine)` +
`rankBoard(spedizioni road, provider road)`, poi merge con lo stesso ordine
totale di MATCHING §7.5 (match prima, surplus ↓, shipmentId) — zero modifiche
al core, determinismo invariato. L'ordine di visita della mappa
(`orderRouteWaypoints`) resta su haversine: è navigazione, non denaro, e
tenerlo sincrono e gratuito evita matrici `/table` per un problema estetico.

### 4. Politica di indisponibilità (il router giù non blocca mai la bacheca)

| Operazione                              | Router giù / coppia irrisolvibile                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Creazione spedizione                     | si crea con metrica `'haversine'` (registrata, definitiva): il mittente non è mai bloccato           |
| Bacheca                                  | i candidati/le spedizioni `road` con coppie fredde sono **omessi in quel refresh** (come le righe malformate, MATCHING §7.2); il resto della bacheca vive |
| `leg_request` / reroute su coppie fredde | errore riprovabile (503): mai un prezzo di ripiego su una metrica diversa                            |
| Numeri advisory (waiting-shipments, stima fee hub) | ripiego haversine dichiarato: sono tetti/stime, il prezzo vero si congela in bacheca (ADR-030) |
| Geometrie (display)                      | fallback a linee rette, sempre: la forma non è denaro                                                |

A regime la cache rende i miss rari (le coppie hub–hub si scaldano da sole);
le coppie sempre fredde sono `O`/`Dc` dei viaggi nuovi — un `/table` per
render di bacheca, budget di timeout breve, poi valgono le righe scritte.

### 5. Costi accettati e documentati

- **Calibrazioni miste**: per un po' il suggeritore di tariffa (MATCHING §4)
  media osservazioni in km haversine e km stradali. È advisory, non denaro;
  si accetta, e sparisce da solo man mano che il parco spedizioni diventa
  `road`.
- **Boards dipendenti dalla salute del router per le coppie fredde**: il
  costo strutturale della decisione A, mitigato dalla cache; misurarlo coi
  dati veri è parte del rodaggio.
- **In sviluppo e in CI** non serve nulla: `OSRM_URL` assente ⇒ tutte le
  spedizioni nascono `'haversine'` e il comportamento è quello di oggi; i
  test del denaro girano senza rete come sempre, più test dedicati con un
  finto OSRM deterministico.

### Parte display (invariata rispetto allo schizzo della proposta)

- Cache `route_geometries` separata (le geometrie non sono denaro: TTL e
  invalidazione libere), polilinea per segmento con
  `source: 'road' | 'straight'`, budget di timeout, fallback rette.
- `GET /trips/:id/route` si estende con le geometrie; la mappa disegna il
  percorso diretto `O → Dc` in tonalità attenuata e il percorso reale
  tappa-per-tappa in tonalità piena — la differenza visiva È la deviazione.
  «Apri in Google Maps» resta invariato.

## Conseguenze

- **ADR-007 è superato per le spedizioni nuove** quando il router è
  disponibile: la metrica di prezzo diventa la distanza stradale OSRM,
  congelata per spedizione. L'argomento di coerenza dell'ADR-007 resta il
  motivo per cui la metrica è **una sola per spedizione** (mai road nel
  filtro e haversine nel prezzo o viceversa) e resta la metrica di nascita
  quando il router manca. ADR-015 va aggiornato (rette = fallback, non più
  scelta).
- Il deploy (ADR-024/DEPLOY.md) guadagna un servizio **opzionale** e la
  procedura di preprocessing/aggiornamento mappe; chi self-hosta senza OSRM
  ha esattamente il comportamento pre-ADR-031.
- `packages/core` non cambia; il denaro nuovo (metrica per spedizione,
  cache first-write-wins, omissioni di bacheca) vive nell'API **con test**
  (regola CLAUDE.md: nessuna logica di denaro senza test).
- Migrazione `0012`: colonna `distance_metric`, tabelle `road_distances` e
  `route_geometries`.
