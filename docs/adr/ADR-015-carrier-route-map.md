# ADR-015 — Mappa del percorso del vettore con export verso Google Maps

- Stato: accettato (richiesta utente) — 2026-07-13; **implementato per
  intero** (2026-07-14)
- Contesto UI: bacheca e viaggio del vettore (MATCHING.md §8)
- Implementazione: parte dati (2026-07-14): `orderRouteWaypoints` in
  `@mercurio/core` e `GET /trips/:id/route` in `apps/api` (tappe ordinate +
  URL Google Maps — precisazioni in fondo). Parte UI (stesso giorno, web
  parte 1): vista viaggio in `apps/web` (`/carrier/trips/:id/route`) —
  Leaflet + tile OSM caricati client-only, polilinea nell'ordine
  dell'endpoint, marker numerati ritiro/consegna (anteprima dalla bacheca
  via `previewShipmentId`/`previewDropHubId` con stile dedicato), tappe
  oltre il tetto elencate sotto la mappa, bottone "Apri in Google Maps" che
  usa l'URL dell'endpoint (nessun dato a Google prima del click),
  attribution OSM corretta.

## Contesto

Il vettore dichiara un viaggio reale (O → Dc) e accetta tratte che gli
impongono deviazioni verso hub di ritiro e consegna. Oggi la deviazione è solo
un numero in km: richiesta utente — una **mappa** che mostri chiaramente il
percorso con le deviazioni verso gli hub, **esportabile con un tasto** verso
Google Maps come percorso navigabile che include tutte le tappe, nell'ordine
più breve.

## Decisione

1. **Mappa in-app: Leaflet + tile OpenStreetMap**, niente API key, niente
   servizi a pagamento (vincolo open source/self-hostable, R6). La mappa
   mostra: partenza `O`, destinazione `Dc`, per ogni tratta accettata (o in
   anteprima dalla bacheca) l'hub di ritiro e l'hub di consegna, e la
   **polilinea del percorso nell'ordine di visita calcolato** (linee rette
   tra tappe: è una visualizzazione dell'itinerario, non routing stradale —
   coerente con ADR-007; il routing vero lo fa Google Maps all'export).
2. **Ordine di visita**: calcolato in `@mercurio/core`
   (`orderRouteWaypoints`, funzione pura sul `DistanceProvider`) come
   percorso aperto più breve `O → … → Dc` che visita tutti gli hub,
   **con il vincolo di precedenza ritiro-prima-di-consegna per ogni
   spedizione a bordo**. Ricerca esaustiva con pruning: i waypoint reali di
   un viaggio sono pochi (≤ 8 tappe ≈ 4 spedizioni); tetto duro
   `MAX_ROUTE_WAYPOINTS = 9` (limite anche delle URL di Google Maps), oltre
   il quale la UI mostra le tappe non instradate in lista.
3. **Export Google Maps: un'URL, nessuna API.** Bottone "Apri in Google
   Maps" che genera
   `https://www.google.com/maps/dir/?api=1&origin=<lat,lng>&destination=<lat,lng>&waypoints=<lat,lng>|…&travelmode=driving`
   con i waypoint nell'ordine calcolato al punto 2 (Google ottimizza il
   percorso stradale sulle singole gambe ma NON riordina le tappe: l'ordine
   — e il vincolo ritiro→consegna — resta nostro). Si apre in una nuova
   scheda/app; su mobile aggancia l'app nativa. Nessuna chiave, nessun dato
   inviato a Google finché il vettore non preme il bottone (GDPR: l'export è
   un'azione esplicita dell'utente, da annotare nella privacy policy).
4. **Privacy**: la mappa in-app usa la posizione dichiarata (O, Dc) e gli
   indirizzi degli hub — nessun tracking della posizione live nell'MVP.

## Alternative considerate

- **Google Maps embed/SDK in-app**: API key, costi a volume, ToS restrittivi
  e tracking di terze parti in pagina. Scartato: OSM in-app, Google solo come
  deep-link volontario.
- **Routing stradale self-hosted (OSRM/Valhalla)** per la polilinea: già
  rimandato da ADR-007; la mappa non lo richiede (le rette tra tappe
  comunicano l'itinerario; i km mostrati restano quelli del
  `DistanceProvider`, gli stessi del prezzo).
- **Ordine di visita banale (ordine di accettazione)**: percorsi
  visibilmente assurdi con ≥ 2 spedizioni; il costo dell'ottimo esatto a
  n ≤ 9 è nullo.

## Conseguenze

- `@mercurio/core` guadagna una funzione pura testabile (proprietà: rispetto
  delle precedenze, ottimalità su istanze piccole vs brute force, stabilità).
- `apps/web` guadagna la prima dipendenza cartografica (leaflet +
  react-leaflet); i tile OSM di default vanno bene per l'MVP, con
  attribution corretta; da riesaminare a volumi alti (policy tile server).
- L'API espone i dati del viaggio già oggi; serve solo un endpoint/selezione
  che restituisca le tappe del viaggio attivo con lat/lng degli hub.

## Precisazioni implementative (parte dati, 2026-07-14)

Decisioni minori emerse implementando, nella direzione della soluzione più
semplice coerente con la decisione:

1. **`orderRouteWaypoints`** (`packages/core/src/matching/route.ts`): DP
   esatta su sottoinsiemi (Held–Karp) con vincolo di precedenza; distanze
   quantizzate al metro intero prima delle somme (come il resto del
   matching: l'ottimo è ben definito e i test lo confrontano col brute
   force in uguaglianza stretta). Ordine canonico dei waypoint in ingresso
   + tie-break per indice ⇒ output indipendente dall'ordine dell'array del
   chiamante (property test). Oltre `MAX_ROUTE_WAYPOINTS` la funzione lancia
   `RangeError`: decide il chiamante cosa lasciare fuori.
2. **`GET /trips/:id/route`** (solo proprietario del viaggio, nessun gate
   sullo stato del viaggio: la vista è di sola lettura e serve anche a
   viaggio scaduto con tratte ancora in transito). Le tappe vengono dalle
   tratte **accettate** (`pending_funding`, `booked`, `picked_up`); una
   tratta `picked_up` contribuisce solo la consegna (il ritiro è già
   avvenuto). Query opzionale `previewShipmentId` + `previewDropHubId`
   (entrambi o nessuno) aggiunge l'anteprima di una spedizione della
   bacheca: ritiro all'hub corrente, consegna all'hub scelto sulla card.
3. **Oltre il tetto**: le tappe si raggruppano per spedizione (mai un
   ritiro instradato senza la sua consegna), tratte in ordine di
   accettazione e anteprima per ultima; i gruppi che non entrano in
   `MAX_ROUTE_WAYPOINTS` tornano in `unroutedStops`, che la UI mostra in
   lista come da decisione 2.
4. **URL Google Maps** generata dal server nello stesso ordine calcolato;
   tappe consecutive sullo stesso hub (consegna + ritiro) collassano in un
   solo waypoint dell'URL.
