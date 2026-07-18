# ADR-030 — Hub discovery a scala (mappa, bbox, ricerca, reverse trip planning)

- Stato: **IMPLEMENTATO — 2026-07-18** (Fase 3 della revisione UX: punti 4–5
  del backlog. Migrazione `0011` — indice `hubs_lat_lng_idx`).
- Contesto: CLAUDE.md «Hub — dettagli» e il requisito del backlog: */hubs
  ordinati per distanza con mappa navigabile; aprire un hub mostra le
  spedizioni in attesa lì; deve reggere 10.000 hub — mai una lista completa
  scorrevole.* [ADR-007](ADR-007-haversine-distance.md) (metrica distanze),
  [ADR-015](ADR-015-carrier-route-map.md) (Leaflet+OSM già in casa),
  [MATCHING §3](../MATCHING.md) (esclusioni di bacheca), ADR-029 (una tratta
  `requested` è fuori bacheca).

## Problema

`GET /hubs` restituiva TUTTI gli hub attivi e la pagina `/hubs` li renderizzava
in un'unica lista. A 30 hub va bene; a 10.000 è inservibile (payload, DOM,
UX di scelta) e ogni richiesta paga l'intera tabella.

## Decisione

### 1. Contratto API paginato, viewport-first

`GET /hubs` accetta `bbox` (minLat,minLng,maxLat,maxLng), `q` (substring
case-insensitive su nome E indirizzo, wildcard LIKE escapate), `near`
(lat,lng → ordina per distanza e valorizza `distanceKm` su ogni hub),
`limit` (default 50, max 200) e `offset`; risponde `{hubs, total}` con
`total` pre-paginazione («N hub in quest'area» senza renderizzarli).
**Compatibilità**: senza NESSUN parametro il contratto legacy (lista intera)
resta — i picker interni (spedisci, reroute, viaggi) ne dipendono; a 10k hub
andranno migrati a una ricerca, fuori dallo scope di questa fase. Nuove rotte:
`GET /hubs/:id` (dettaglio pubblico, stessa forma della lista) e
`GET /hubs/:id/waiting-shipments` (sotto).

### 2. Niente PostGIS: btree su (lat, lng) + filtro in SQL, distanza in processo

Il filtro bbox è un `BETWEEN` su lat/lng assistito dal nuovo indice btree
`hubs_lat_lng_idx` (migrazione 0011); l'ordinamento per distanza usa il
`DistanceProvider` (haversine × 1.3, ADR-007) sull'insieme GIÀ filtrato dal
viewport. A 10k righe l'insieme filtrato è piccolo per costruzione; PostGIS
(o pg_trgm per la ricerca) restano l'upgrade quando i numeri reali lo
chiederanno, dietro lo stesso contratto — coerente con la filosofia ADR-007
(«da fare quando ci saranno lamentele reali, non prima»).

### 3. Mappa navigabile con clustering a griglia, senza nuove dipendenze

La pagina `/hubs` diventa mappa (Leaflet + OSM, come ADR-015) + lista.
Il **viewport comanda i dati**: ogni pan/zoom ri-interroga l'API con la bbox
corrente (debounce 350 ms, `limit=200` — il massimo di pagina). I marker
si aggregano con un **clustering a griglia screen-space**
(`apps/web/lib/map-cluster.ts`, funzione pura: cella ≈ 1/8 di tile, i cluster
mostrano il conteggio e al click zoomano di 2 livelli). Niente
`leaflet.markercluster`: la pagina non riceve mai più di una pagina bounded,
quindi una griglia basta — zero dipendenze nuove, testabile. La lista sotto la
mappa è ordinata per distanza dal centro (`near`), paginata client-side a
blocchi di 20 con «Carica altri»; la ricerca testuale vola sui risultati.
La geolocalizzazione è **solo su tap** («Usa la mia posizione»), mai
automatica (minimizzazione GDPR).

### 4. Reverse trip planning: le spedizioni in attesa di un hub

`GET /hubs/:id/waiting-shipments` (con sessione: l'inventario di uno scaffale
non è per il web aperto) elenca le spedizioni `AT_HUB` presso l'hub e LIBERE
secondo le regole di bacheca (MATCHING §3 + ADR-029: una tratta richiesta/
pendente/prenotata o un claim vivo le esclude). Ogni voce porta codename,
destinazione con distanza, dimensioni/peso, bond e **`maxGrossMsat`**: il
tetto indicativo — pool di lavoro residuo + Π_v maturata — che lorderebbe una
consegna diretta a destinazione. È dichiaratamente un *tetto*, non un prezzo:
i numeri congelati arrivano solo dalla bacheca dopo la dichiarazione del
viaggio, e la UI lo dice («il prezzo reale della tua tratta si congela in
bacheca»). La pagina `/hubs/:id` chiude il cerchio con la CTA «Dichiara un
viaggio che passa di qui».

## Alternative considerate

- **PostGIS subito**: potenza geografica vera, ma una dipendenza infra in più
  per un MVP i cui volumi non la giustificano; il contratto bbox non cambia
  quando arriverà. Rimandata.
- **leaflet.markercluster**: plugin maturo, ma pensato per migliaia di marker
  GIÀ nel DOM — il nostro collo di bottiglia è il payload, risolto a monte
  dalla bbox; la griglia in 40 righe pure fa il resto. Scartata.
- **Waiting-shipments pubblico senza sessione**: più attrito zero per i
  vettori curiosi, ma espone l'inventario degli scaffali (cosa c'è, dove va,
  che bond richiede) a chiunque. Sessione richiesta. Scartata.

## Conseguenze

- La pagina hub regge 10k hub per costruzione: il client non riceve mai più
  di 200 righe, il DOM mai più di ~20 card + cluster.
- I picker interni restano sul contratto legacy: debito noto e documentato,
  da saldare con una search-UX quando i volumi lo impongono (Fase 5+).
- Il flusso vettore guadagna l'ingresso «prima l'hub, poi il viaggio»
  (reverse trip planning) senza toccare il protocollo: nessun denaro, nessun
  nuovo stato — solo lettura.
