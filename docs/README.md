# Mercurio — Documentazione di progetto

> Regola dal CLAUDE.md: leggere `/docs` prima di ogni task; se manca una decisione,
> proporla e aggiornare `/docs`.

Stato attuale (2026-07-17): architettura approvata; implementati db+ledger,
auth/API di base, motore economico, matching, macchina a stati, coordinatore
escrow non custodiale, premio di finalizzazione (ADR-014), **API del ciclo
di vita delle spedizioni** (executor degli effetti, bacheca del viaggio,
wallet-event pump, timer e worker pg-boss; OpenAPI servita su `/docs`
dell'API — precisazioni in ARCHITECTURE §5), **ritiro anticipato del
destinatario** (ADR-016: token di tracking, claim con hold P2P, stato
`CLAIMED`), **recensioni con aggregati per ruolo** (ADR-017: guardie sui
ruoli effettivi, rating su bacheca/hub/dettaglio/profilo), la **mappa del
vettore completa** (ADR-015: `orderRouteWaypoints`, `GET /trips/:id/route`
con export Google Maps, vista Leaflet in `apps/web`), la **web UI parte 1**
(ADR-018: fondamenta i18n it/en, client tipizzato sugli schemi condivisi,
flusso mittente — hub, form Spedisci con QR stampabile, tracking con
boost/reroute/cancel — e flusso vettore — viaggio, bacheca, accettazione
tratta, vista viaggio), la **web UI parte 2** (ADR-018 §6: registrazione e
dashboard hub, operazioni di passaggio di mano via QR con foto hashate sul
dispositivo, check-out a doppia conferma, ritiro OTP, pagina
tracking/claim del destinatario linkata dalle email, recensioni con profilo
pubblico, export/cancellazione GDPR in UI), le **liste account**
(`GET /me/shipments`/`GET /me/trips`, ADR-018 §5 — il localStorage è stato
rimosso), l'**adapter NWC reale** (ADR-019: probe delle capability al
collegamento, interop verificata su regtest con relay nostr + Alby Hub) e il
**blob storage delle foto** (ADR-020: upload verificato contro l'hash
certificato, EXIF rimosso sul dispositivo, download solo via API con authz
di sessione, purge worker con retention GDPR) e lo **scanner QR in pagina**
(ADR-021: BarcodeDetector nativo dove disponibile, campo testo come fallback
universale, stream fotocamera mai fuori dal dispositivo), le **foto del
mittente alla creazione** (ADR-022: hash `content`/`sealed` opzionali
dichiarati nella `POST /shipments` e certificati dall'evento `created`,
upload e visibilità con le guardie di ADR-020), i **testi legali**
(docs/legal: [TOS.md](legal/TOS.md) e [PRIVACY.md](legal/PRIVACY.md), serviti
dalle pagine `/tos` e `/privacy` del web con parità it/en, linkate dal footer
e dal consenso al primo login — che ora registra anche l'approvazione
specifica ex artt. 1341-1342 c.c.; il worker manda i preavvisi di giacenza a
72/24 h e ogni mail del ciclo di vita porta il link all'informativa,
artt. 14/21 GDPR) e il **driver S3-compatibile per il blob storage delle
foto** (ADR-023: stessa interfaccia `BlobStore` di ADR-020, selezione da
config con `PHOTO_STORAGE_DRIVER` — default filesystem, invariato — MinIO
nel docker-compose di sviluppo solo per testare il driver stesso, refcount e
purge invariati) e il **deploy di produzione** (ADR-024: immagini multi-stage
per api e web, compose su singolo VPS in `infra/production/` con Caddy come
unica origin pubblica — `/api/*` al proxy, stesso contratto same-origin
dell'ADR-018 — migrazioni come servizio one-shot, segreti solo da env, backup
di Postgres e foto; guida in [DEPLOY.md](DEPLOY.md)) e il **cambio EUR→sats
reale** (ADR-025: mediana di tre ticker BTC/EUR pubblici senza chiave, presi
solo server-side e tenuti in cache 5 minuti dietro lo stesso `EurRateProvider`
di ADR-008 — la matematica intera non cambia; una fonte rotta è l'outlier e
viene scartata. Il tasso fisso da env resta il default di sviluppo, perché i
sats di regtest non hanno un prezzo di mercato, mentre in produzione **nessun
cambio può venire da un default**: senza `EUR_RATE_PROVIDER` l'API rifiuta di
avviarsi, come già fa con `FAKE_WALLETS`. Un feed giù non ferma niente che non
chieda uno snapshot nuovo — release/refund, check-in/out, ritiri e claim
leggono il cambio congelato sulla riga — e solo `POST /shipments` risponde
`503` oltre le 6 ore di età massima, perché lì il cambio si congela per tutta
la vita della spedizione). Preparando il deploy sono
emersi e chiusi due difetti che solo la produzione avrebbe rivelato: l'output di
`tsc` non era eseguibile da Node (import relativi senza estensione — la `dist/`
non era mai stata eseguita: `pnpm dev` gira su tsx e i test su vitest) e i
**rate limit anti-abuso erano inerti** (`@fastify/rate-limit` registrato senza
`await`: nessun limite di RISKS §7 veniva applicato). Sul branch
`feat/ux-overhaul-1` è in corso la **revisione UX/prodotto** (backlog UX):
Fase 1 completa (codename delle spedizioni, giacenza in giorni — ADR-026,
recensioni solo hub — ADR-027, audit importi EUR+sats) e Fase 2 in corso —
orari di apertura dell'hub, **foto del locale + email di contatto + avviso di
deposito via outbox** ([ADR-028](adr/ADR-028-hub-venue-and-deposit-notice.md))
e **guadagno stimato/puntuale su ogni richiesta della dashboard hub**
(`estimateHubFeeRange`, ECONOMICS §7). **Da implementare**: app
mobile. **Todo umano**: revisione dei testi legali da parte di un legale;
acquisto di VPS e dominio; un check di uptime esterno su `/api/health`.

## Documenti

| Documento                          | Contenuto                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Stack, componenti, modello dati (ER), macchina a stati del pacco con eventi bond/escrow, invarianti                              |
| [ECONOMICS.md](ECONOMICS.md)       | Motore economico multi-tratta: 3 modelli simulati, raccomandazione (progress-based)                                              |
| [ESCROW.md](ESCROW.md)             | Pagamenti senza custodia: hold invoice dirette P2P, coordinatore per preimage, interfacce `WalletConnection`/`EscrowCoordinator` |
| [MATCHING.md](MATCHING.md)         | Matching vettore ↔ spedizioni: deviazione, scelta dell'hub, tariffa suggerita, ordinamento bacheca                               |
| [RISKS.md](RISKS.md)               | Integrità senza arbitro, anti-abuso, identità, svincolo a fine giacenza, GDPR, punti legali ⚖️                                   |
| [DEPLOY.md](DEPLOY.md)             | Guida al deploy: prerequisiti, env, primo deploy, aggiornamento, backup e ripristino                                            |
| [legal/TOS.md](legal/TOS.md)       | Termini di servizio: contratto tra pari, esiti deterministici, svincolo marciano — ogni clausola cita la transizione            |
| [legal/PRIVACY.md](legal/PRIVACY.md) | Informativa privacy (artt. 13-14 GDPR): basi per ruolo, minimizzazione by design, retention foto, export/cancellazione        |

## Architecture Decision Records

| ADR                                                 | Decisione                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [ADR-001](adr/ADR-001-monorepo-typescript-pnpm.md)  | Monorepo TypeScript + pnpm workspaces                                                 |
| [ADR-002](adr/ADR-002-nextjs-web-fastify-api.md)    | Next.js per il web, API pubblica separata su Fastify + OpenAPI                        |
| [ADR-003](adr/ADR-003-postgresql-drizzle.md)        | PostgreSQL + Drizzle ORM                                                              |
| [ADR-004](adr/ADR-004-lnd-regtest-docker.md)        | bitcoind regtest + LND (wallet utente di test) via Docker Compose                     |
| [ADR-005](adr/ADR-005-escrow-backend-lnbits.md)     | ~~LNbits custodial~~ — superseded da ADR-013                                          |
| [ADR-006](adr/ADR-006-progress-based-economics.md)  | Ripartizione proporzionale ai km di avvicinamento                                     |
| [ADR-007](adr/ADR-007-haversine-distance.md)        | Distanze: haversine × 1.3 dietro `DistanceProvider`                                   |
| [ADR-008](adr/ADR-008-amounts-in-sats.md)           | Importi in msat; EUR solo input/display con cambio congelato                          |
| [ADR-009](adr/ADR-009-auth-email-lnurl.md)          | Auth: magic link email + LNURL-auth opzionale                                         |
| [ADR-010](adr/ADR-010-double-entry-ledger.md)       | Ledger a partita doppia, append-only, riconciliato                                    |
| [ADR-011](adr/ADR-011-pg-boss-jobs.md)              | Timeout e code su pg-boss (Postgres)                                                  |
| [ADR-012](adr/ADR-012-no-arbiter.md)                | Nessun arbitro: certificazioni + esiti deterministici, rifiuto al posto della disputa |
| [ADR-013](adr/ADR-013-non-custodial-coordinator.md) | Zero custodia: coordinatore per preimage, pagamenti diretti P2P                       |
| [ADR-014](adr/ADR-014-finalization-bonus.md)        | Premio di finalizzazione: 10% dell'impegno → 70% vettore finale, 30% hub finale       |
| [ADR-015](adr/ADR-015-carrier-route-map.md)         | Mappa del viaggio del vettore (Leaflet/OSM) + export percorso su Google Maps          |
| [ADR-016](adr/ADR-016-recipient-claim.md)           | Ritiro anticipato del destinatario: claim con token bearer, pool residuo + Π_v        |
| [ADR-017](adr/ADR-017-reviews.md)                   | Recensioni: ruoli effettivi, tutte le chiusure recensibili, finestra 30 giorni        |
| [ADR-018](adr/ADR-018-web-ui-platform.md)           | Web UI: proxy same-origin (niente CORS), importi sats-first solo dall'API, i18n a cookie |
| [ADR-019](adr/ADR-019-nwc-adapter.md)               | Adapter NWC reale: probe delle capability, interop verificata su regtest              |
| [ADR-020](adr/ADR-020-photo-blob-storage.md)        | Foto: blob storage fs content-addressed, EXIF strip sul dispositivo, accesso solo via API |
| [ADR-021](adr/ADR-021-in-page-qr-scanner.md)        | Scanner QR in pagina: BarcodeDetector nativo, campo testo come fallback universale, nessun decoder nel bundle |
| [ADR-022](adr/ADR-022-sender-creation-photos.md)    | Foto del mittente alla creazione: certificazione nell'evento `created`, upload con le guardie di ADR-020 |
| [ADR-023](adr/ADR-023-s3-blob-storage-driver.md)    | Driver S3-compatibile per il blob storage delle foto (MinIO/Garage), selezione da config, MinIO dev opt-in |
| [ADR-024](adr/ADR-024-production-deploy.md)         | Deploy: immagini multi-stage, compose su singolo VPS, Caddy unica origin, segreti solo da env |
| [ADR-025](adr/ADR-025-eur-rate-market-provider.md)  | Cambio EUR→sats reale: mediana di ticker pubblici senza chiave, cache in processo, fisso solo per dev |
| [ADR-026](adr/ADR-026-storage-in-days.md)           | Giacenza in giorni (cap 7 subito); i 30 giorni via bond a rinnovo rolling, da implementare a parte |
| [ADR-027](adr/ADR-027-reviews-hub-only.md)          | Recensioni: l'unico soggetto recensibile è l'hub (emenda ADR-017) |
| [ADR-028](adr/ADR-028-hub-venue-and-deposit-notice.md) | Foto del locale (tabella + store separati), email di contatto dell'hub, avviso di deposito via outbox |

## Stato delle decisioni

Le decisioni chiave sono state confermate in revisione il 2026-07-12 (elenco in
[RISKS.md §8](RISKS.md)): modello economico B con fee hub sul lordo di tratta, bond
unico fino a 1.000 €, valore dichiarabile ≤ 45 €, offerta libera con prezzo
consigliato, boost + reroute del mittente, ritiro definitivo senza finestra di
contestazione, nessun arbitro (ADR-012), nessun controllo AML preventivo,
**zero custodia in ogni momento** (ADR-013 — pagamenti diretti P2P, la piattaforma
non tocca mai fondi), fee piattaforma 0%. I punti legali ⚖️ sono stati chiusi il
2026-07-17 come decisioni di progetto motivate dalle norme (RISKS.md §2, §4, §5,
§6); i testi — ToS e informativa privacy — sono redatti lo stesso giorno in
[docs/legal](legal/TOS.md) e pubblicati su `/tos` e `/privacy`. Resta il todo
umano della revisione da parte di un legale (RISKS.md §8).
