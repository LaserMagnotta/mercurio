# ADR-015 — Mappa del percorso del vettore con export verso Google Maps

- Stato: accettato (richiesta utente) — 2026-07-13
- Contesto UI: bacheca e viaggio del vettore (MATCHING.md §8)
- Implementazione: **da fare**

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
