# ADR-004 — Lightning di sviluppo: bitcoind regtest + LND via Docker Compose

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Tutta la logica di denaro va testata senza fondi reali, in modo riproducibile e in CI.
Con l'architettura zero-custodia (ADR-013) la piattaforma non ha un nodo proprio:
servono i **wallet degli utenti** — nodi Lightning di test per mittente, vettore e
hub — su cui esercitare hold invoice, rivelazioni di preimage e annullamenti.

## Decisione

`infra/docker/docker-compose.yml` con: `bitcoind` in **regtest**, **LND** ×3 come
wallet utente (`lnd-alice` mittente, `lnd-bob` vettore, `lnd-carol` hub), più
`postgres` e `mailpit`. Script di bootstrap idempotente: mina i blocchi iniziali,
finanzia i wallet, apre i canali alice↔bob↔carol. In dev i wallet sono collegati
tramite l'adapter `lnd_rest` di `WalletConnection` (la stessa interfaccia
dell'adapter NWC di produzione). I test di integrazione girano contro questo
ambiente anche in CI (GitHub Actions con i servizi Docker).

Implementazione LND (e non altre) perché le **hold invoice** (`invoicesrpc`) — il
cuore del meccanismo ADR-013 — sono una sua funzione matura e ben documentata, e
l'ecosistema di tooling è il più ampio.

## Alternative considerate

- **Polar**: perfetto per esplorare a mano, ma è un'app GUI: non gira in CI. Resta
  consigliato come strumento personale di sviluppo, non è l'ambiente di riferimento.
- **Core Lightning / Eclair**: valide (CLN ha `holdinvoice` via plugin), ma tooling
  meno battuto per il nostro caso; nessun vantaggio che giustifichi la strada meno
  percorsa. Restano compatibili lato utente: basta un adapter `WalletConnection`.
- **Testnet/signet invece di regtest**: lenti (blocchi veri), faucet, flakiness in CI.
  Regtest è deterministico; signet utile più avanti come staging pre-mainnet.
- **Mock del layer Lightning nei test**: c'è comunque (adapter `fake` di
  `WalletConnection` per i test unitari di core), ma i test *di integrazione*
  devono attraversare hold invoice vere.

## Conseguenze

- Chi clona il repo ha una rete Lightning funzionante con `docker compose up` + script.
- CI più lenta ma onesta: i bug di pagamento emergono prima del mainnet.
- Il passaggio a produzione cambia solo configurazione (mainnet, macaroon, TLS),
  non codice.
