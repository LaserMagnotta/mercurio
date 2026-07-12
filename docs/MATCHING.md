# Mercurio — Motore di matching vettore ↔ spedizioni

> Stato: **bozza per revisione** — 2026-07-12.
> Distanze: [ADR-007](adr/ADR-007-haversine-distance.md). Prezzi delle tratte: [ECONOMICS.md](ECONOMICS.md).

## 1. Input

**Il vettore dichiara il viaggio reale** prima di vedere la bacheca (`carrier_trips`):

| Campo | Simbolo | Esempio |
|---|---|---|
| Partenza (posizione attuale / hub di riferimento) | `O` | Bologna |
| Destinazione del viaggio | `Dc` | Firenze |
| Deviazione massima | `dev_max` | 15 km |
| Tariffa minima per km di deviazione | `rate_min` | 0,20 €/km (suggerita dal sistema, §4) |

**Ogni spedizione in bacheca** (stato `AT_HUB`) porta: hub corrente `S` (con la sua
percentuale `f_S`), hub di destinazione `T`, distanza residua `r_S = d(S, T)`,
distanza totale `D`, pool residuo contabile `pool = P × r_S / D + boost` (aggiornato
da boost e reroute del mittente — ECONOMICS §5), bond
di custodia richiesto, vincoli fisici (dimensioni, peso, contenuto non dichiarato sì/no).

## 2. Distanza e deviazione

### Metrica: haversine × fattore di circuità (MVP)

`d(x, y) = haversine(x, y) × k`, con `k = 1.3` (rapporto tipico strada/linea d'aria in
Europa). Scelta motivata in ADR-007, in sintesi:

- **Coerenza interna**: la stessa metrica è usata sia per il **prezzo** della tratta
  (`Δr`, ECONOMICS.md) sia per il **filtro** di deviazione. Gli errori sistematici
  (montagne, laghi) distorcono numeratore e denominatore nella stessa direzione,
  quindi il *rapporto* convenienza/costo regge meglio del valore assoluto.
- Zero dipendenze esterne, deterministica, gratuita, testabile — giusto per un MVP
  il cui collo di bottiglia è la liquidità di vettori, non la precisione geografica.
- Il costo dell'errore è basso: la deviazione dichiarata è una *preferenza* del
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
2. **progresso positivo e non-banale**: `r_S − d(H,T) ≥ max(5 km, 5% × D)` (ECONOMICS.md);
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
`rate_min = 0,20 €/km`. Spedizione: `P = 5,00 €`, hub corrente `S=(30,10)` con
`f_S = 10%`, destinazione `T=(90,10)` con `f_T = 10%`, `r_S = 60 km`, `D = 80 km`,
pool residuo `5,00 × 60/80 = 3,75 €`.

| Candidato | `f_H` | progresso | detour | gross | net (`×(1−f_S−f_H)`) | soglia (`rate_min×detour`) | surplus | esito |
|---|---|---|---|---|---|---|---|---|
| `H1=(60,5)` | 10% | 29,6 km | 2,3 km | 1,85 | 1,48 | 0,46 | **+1,02** | match |
| `T=(90,10)` (consegna finale) | 10% | 60 km | 5,7 km | 3,75 | 3,00 | 1,14 | **+1,86** | match, `H*` |
| `H3=(50,40)` | 5% | 10 km | 31,7 km | — | — | — | — | escluso: `detour > dev_max` |

La consegna diretta a destinazione vince (surplus massimo): è l'esito desiderato quando
la destinazione è quasi sulla rotta del vettore. `H1` resta visibile come alternativa.

## 3. Bacheca: ordinamento

La bacheca dell'hub mostra tutte le spedizioni in stato `AT_HUB` presso quell'hub
(e, in una vista "lungo il tuo viaggio", quelle negli hub vicini alla rotta):

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
- **Anti-manipolazione**: si osservano solo tratte *accettate e poi completate* (una
  campagna di accettazioni fasulle costa bond e tempo); minimo 30 osservazioni prima
  di abbandonare il default; in futuro bucket per area geografica quando i volumi lo
  giustificano.
- La tariffa suggerita è mostrata al vettore alla dichiarazione del viaggio con
  copy esplicito ("i vettori nella tua zona hanno accettato in media…").

## 5. Offerta consigliata al mittente

Speculare alla tariffa del vettore, ma dal lato opposto del mercato: al mittente che
compila la spedizione il sistema propone **un'offerta che consegna**, non un ribasso.
L'offerta resta **libera** (decisione utente): più si offre, più cresce il surplus di
ogni tratta e più in alto la spedizione compare nella bacheca di *tutti* i vettori
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

```ts
export interface DistanceProvider {
  /** Road-distance estimate in km. MVP: haversine × 1.3. Future: OSRM. */
  distanceKm(a: GeoPoint, b: GeoPoint): number;
}

export interface MatchCandidate {
  shipmentId: string;
  bestDropHub: { hubId: string; detourKm: number; netMsat: bigint; surplusMsat: bigint };
  alternatives: Array<{ hubId: string; detourKm: number; netMsat: bigint; surplusMsat: bigint }>;
  isMatch: boolean;   // detour ≤ dev_max && surplus ≥ 0
}

/** Pure function: (trip, shipments-at-hubs, hubs, provider) → ranked board. */
export function rankBoard(
  trip: CarrierTrip,
  shipments: ShipmentAtHub[],
  hubs: Hub[],
  distance: DistanceProvider,
): MatchCandidate[];
```

Funzione pura: testabile con scenari geometrici sintetici (come l'esempio §2) e
proprietà (mai suggerire hub con progresso ≤ soglia; surplus coerente con ECONOMICS).
