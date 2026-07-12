# ADR-007 — Distanze: haversine × fattore di circuità, dietro `DistanceProvider`

- Stato: proposto (in revisione) — 2026-07-12
- Uso nel matching: [MATCHING.md](../MATCHING.md) §2

## Contesto

Distanze e deviazioni governano sia il prezzo delle tratte (ECONOMICS) sia il matching.
Opzioni: haversine (linea d'aria), haversine corretta, routing stradale reale
(OSRM/Valhalla self-hosted o API commerciali).

## Decisione

MVP: `d(a,b) = haversine(a,b) × k`, con **k = 1.3** (fattore di circuità tipico della
rete stradale europea: il rapporto strada/linea d'aria empirico sta in ~1.2–1.4).
Implementata in `packages/core` dietro l'interfaccia `DistanceProvider`.

Perché basta per l'MVP:

- **Coerenza interna**: prezzo e filtro di deviazione usano la stessa metrica, quindi
  gli errori sistematici si compensano nei _rapporti_ (surplus, €/km) anche dove il
  valore assoluto sbaglia.
- La deviazione è una preferenza del vettore, non un vincolo contrattuale: vede mappa
  e hub prima di accettare; l'errore non genera obblighi sbagliati.
- Deterministica, gratuita, senza dipendenze né rete: testabile con geometrie sintetiche.

## Alternative considerate

- **Routing reale self-hosted (OSRM/Valhalla)**: preciso ma richiede estratti OSM,
  RAM, operatività — costo sproporzionato quando il collo di bottiglia dell'MVP è la
  liquidità di vettori, non la geografia. È l'upgrade previsto, da fare quando i
  dati reali lo giustificheranno, non la partenza.
- **API commerciali (Google/Mapbox)**: costi variabili, dipendenza esterna, ToS e
  privacy (coordinate utenti a terzi). Contro lo spirito self-hostable del progetto.
- **Haversine nuda (k=1)**: sottostima sistematicamente i km reali → tariffe €/km
  gonfiate artificialmente. La correzione costa una moltiplicazione.

## Conseguenze

- Casi geograficamente patologici (stretti, valli alpine) daranno stime scadenti:
  accettato; l'interfaccia consente di passare a OSRM senza toccare il dominio
  quando le dispute reali lo giustificheranno.
- `k` è una costante di configurazione documentata, ricalibrabile sui dati veri
  (confronto con km dichiarati/percepiti dai vettori).
