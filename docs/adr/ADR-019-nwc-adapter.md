# ADR-019 — Adapter NWC reale: quali metodi, come si negozia, come si degrada

- Stato: accettato e implementato — 2026-07-16
- Chiude: il roadmap item di [ADR-013](ADR-013-non-custodial-coordinator.md)
  ("L'adapter NWC di produzione resta da fare")
- Contesto: `packages/escrow/src/adapters/nwc.ts`; interfaccia da rispettare in
  [ESCROW.md](../ESCROW.md) §5 (`WalletConnection`)

## 1. Contesto

ADR-013 lascia esplicitamente in sospeso l'adapter NWC di produzione. Il
contratto `WalletConnection` include `makeHoldInvoice` / `settleHoldInvoice` /
`cancelHoldInvoice`: prima di implementare bisognava verificare se NWC (NIP-47)
supporta davvero le hold invoice, dato che lo standard base non le prevede.

## 2. Stato dell'ecosistema (verificato, non presunto)

**NIP-47 base non copre le hold invoice.** I metodi `pay_invoice`,
`make_invoice`, `lookup_invoice`, `get_balance`, `get_info` sono lo "zoccolo"
del protocollo. Le hold invoice sono un'**estensione già mergiata** nel NIP-47
ufficiale (non un'invenzione nostra): `make_hold_invoice` (crea l'invoice da
una preimage/hash già scelta dal chiamante — esattamente il pattern del
coordinatore per preimage, ADR-013 §2), `settle_hold_invoice`,
`cancel_hold_invoice`, con la notifica `hold_invoice_accepted` quando l'HTLC
si blocca. Implementazioni verificate: **Alby Hub** (LND-backed) e l'Alby CLI
espongono questi tre comandi; il supporto è citato esplicitamente nella guida
sviluppatori Alby e nel changelog NWC v0.4.1. Non è quindi un'ipotesi da
verificare a runtime "nella speranza che funzioni": è un'estensione reale,
implementata da almeno un wallet service di produzione.

**Conseguenza pratica**: un wallet NWC può benissimo NON implementarla (i
wallet "solo pagamenti" restano legittimi per ruoli non money-bearing, se mai
ce ne fossero — nell'MVP non ce ne sono, vedi §4). Il nostro adapter deve
quindi trattare `holdInvoice` come una **capability opzionale da sondare**,
non come un requisito del protocollo NWC in sé.

## 3. Decisione: probing e negoziazione

1. **Encryption**: NIP-44 v2 preferita, NIP-04 come fallback legacy (lo dice
   la spec stessa). Non ci affidiamo al tag `encryption` dell'evento kind
   `13194` (info event) perché non tutte le implementazioni lo tengono
   aggiornato con la stessa disciplina della risposta a `get_info`: **il
   probe tenta NIP-44, e se non arriva risposta nel timeout tenta NIP-04**
   sullo stesso `get_info`. Uno schema di cifratura sbagliato si manifesta
   come un timeout silenzioso (il wallet non riesce a decifrare e non
   risponde affatto) — comportamento noto e documentato nell'ecosistema
   Alby, non un'anomalia del nostro adapter.
2. **Capability probing = `get_info`**, non l'info event kind `13194`. La
   lista `methods` della risposta a `get_info` è la fonte di verità: se
   contiene `make_hold_invoice` + `settle_hold_invoice` + `cancel_hold_invoice`
   → `capabilities.holdInvoice = true`; se contiene
   `pay_invoice` + `make_invoice` + `lookup_invoice` → `capabilities.baseline`
   (il minimo perché il wallet sia usabile IN QUALSIASI RUOLO, §4).
3. **Encryption negoziata una sola volta**, al connect: il risultato
   (`nip44_v2` o `nip04`) si salva in `wallet_connections.capabilities`
   insieme a `holdInvoice`, così ogni chiamata successiva (che nel codice
   attuale ricostruisce un `NwcWallet` fresco ad ogni `resolveWallet`, senza
   cache di connessione) non ripete il tentativo-fallimento-fallback: userebbe
   altrimenti un timeout intero ad ogni singola operazione di pagamento per i
   wallet NIP-04-only.
4. **Relay per-chiamata, non sessione persistente**: ogni chiamata NWC apre
   una connessione WebSocket fresca (Node 22+ ha `WebSocket` globale, nessuna
   dipendenza aggiuntiva), pubblica la request, aspetta la risposta con un
   timeout, chiude. Le chiamate NWC di Mercurio avvengono a milestone del
   protocollo (accettazione tratta, bond, settlement) — mai in hot loop — per
   cui il costo di una connessione per chiamata è accettabile e molto più
   semplice di gestire riconnessioni/sottoscrizioni concorrenti su una
   sessione condivisa.
5. **Ogni risposta è verificata indipendentemente dal relay**: un relay è
   trasporto non fidato. Prima di fidarsi di una risposta si ricalcola il suo
   id (hash) e si verifica la firma schnorr contro la pubkey del wallet
   atteso — un relay malevolo che inietta un evento farlocco viene ignorato
   (testato in `nwc.test.ts`, "ignores a forged reply from an impersonator").

## 4. Wallet senza supporto hold invoice: connessione accettata, ruolo rifiutato

Come chiesto in revisione: la connessione **non viene rifiutata** solo perché
manca l'estensione hold — molti wallet NWC "solo pagamenti" sono comunque
legittimi per usi futuri non money-bearing. Si rifiuta invece **l'uso**:

- `POST /me/wallet` con `kind:'nwc'` accetta la connessione se il wallet
  supporta almeno `baseline` (altrimenti non è utilizzabile da Mercurio in
  NESSUN modo → `nwc_missing_required_methods`, niente riga scritta).
  `capabilities.holdInvoice` riflette semplicemente cosa il probe ha trovato.
- **In Mercurio, però, ogni ruolo money-bearing (mittente, vettore, hub) è
  prima o poi PAYEE di una hold invoice** (ESCROW.md §3: il mittente emette i
  bond di vettore e hub cedente; il vettore emette il pagamento tratta; l'hub
  di destinazione emette il premio di finalizzazione nel claim). Non esiste
  quindi un ruolo che possa restare money-bearing con `holdInvoice: false`:
  la capability è di fatto universale, non selettiva per operazione.
  `apps/api/src/lib/wallets.ts` la applica in **un solo punto**
  (`createDbWalletResolver`, più lo speculare `hasConnectedWallet`), senza
  toccare `PreimageCoordinator` né gli altri effect executor: un NWC wallet
  con `holdInvoice: false` fa fallire **qualunque** risoluzione con
  `WalletCapabilityError` → HTTP 402 `wallet_missing_hold_support`, distinto
  da `wallet_unavailable` (nessun wallet collegato) perché l'azione correttiva
  per l'utente è diversa ("ricollega un wallet capace", non "collega un
  wallet").
- Scartata l'alternativa di un check per-operazione (payer non avrebbe
  bisogno di hold support, solo il payee): avrebbe richiesto toccare
  `coordinator.ts` (esplicitamente fuori scope) e comunque, per come è
  strutturato il protocollo (§ sopra), converge sempre al rifiuto totale.

## 5. Gap noti dello standard, accettati e documentati (non finti)

- **`pay_invoice` non ha un segnale di "dispatch"**: la risposta base è
  `{preimage, fees_paid}`, pensata per invoice normali che si risolvono in
  secondi. Per una hold invoice il pagatore non riceverà MAI la preimage (sta
  al coordinatore), quindi una wallet service che rispettasse alla lettera lo
  schema resterebbe in attesa per l'intera finestra di hold (fino a un'ora,
  ESCROW.md §3) prima di rispondere. Non esiste, ad oggi, un'estensione NIP-47
  equivalente allo streaming di LND (`/v2/router/send`, ADR-013) per il lato
  pagatore. **Decisione**: `payInvoice` usa un timeout generoso e dedicato
  (`payInvoiceTimeoutMs`, default 90 s) invece di quello standard (20 s); un
  timeout qui NON è pericoloso per il protocollo — significa solo che la hold
  non raggiunge mai `held` e la finestra di funding scade normalmente
  (ESCROW.md §2, default sicuro). Non è un problema che Mercurio possa
  risolvere unilateralmente: è una lacuna dello standard, da segnalare a
  monte (issue NIP-47), non da aggirare con finti stati "dispatched".
- **Nessun parametro di fee budget in `pay_invoice`**: a differenza
  dell'adapter LND REST (`fee_limit_msat`), NIP-47 non espone un limite fee
  per chiamata — si applica la policy del wallet stesso. `maxFeeMsat` resta
  nella firma per parità d'interfaccia ma non ha effetto sull'adapter NWC
  (commentato nel codice, non silenziato).
- **Lo `state` di `lookup_invoice` non è specificato in modo esaustivo** una
  volta che entrano in gioco le hold invoice (l'estensione documenta
  `pending`/`accepted`/`settled` più le notifiche hold-specifiche, ma non un
  enum chiuso e verificato per ogni implementazione). `mapInvoiceState`
  riconosce i valori noti e, per tutto il resto, ricade sul confronto con
  `expires_at` — la stessa strategia open-vs-expired già adottata
  dall'adapter LND REST (ADR-013, "dettagli implementativi", punto 2) per un
  gap concettualmente identico.
- **`payInvoice` deve comunque restituire un `paymentHash`** (contratto
  `WalletConnection`) ma la risposta NWC non lo include mai (nemmeno per le
  invoice normali). Lo recuperiamo decodificando il BOLT11 stesso
  (`adapters/bolt11.ts`, tag `p`): è l'unica fonte indipendente dal wallet, e
  funziona identicamente per hold e non-hold invoice. Il valore non è oggi
  usato per decisioni di denaro da nessun chiamante (`coordinator.ts`,
  `instant.ts` lo scartano) — è comunque calcolato correttamente, non
  fabbricato, perché usarlo in futuro senza saperlo derivato bene sarebbe un
  rischio silenzioso.

## 6. Scelte implementative minori

- **Crypto**: `@noble/curves` + `@noble/hashes` + `@noble/ciphers` (le stesse
  librerie su cui è costruito `nostr-tools`), non `nostr-tools` stesso —
  evita la dipendenza da `nostr-wasm` e da `@scure/bip32`/`bip39` (derivazione
  da mnemonic, non pertinente qui) e lascia scrivere il trasporto relay in
  modo iniettabile per i test. NIP-04 (AES-256-CBC) e NIP-44 v2 (HKDF +
  ChaCha20 + HMAC-SHA256, padding a bucket di potenze di due) sono
  implementati da zero seguendo lo pseudocodice della NIP-44 dalla spec
  ufficiale (`packages/escrow/src/nostr/nip44.ts`), verificati con round-trip
  su tutti i bucket di padding e con test di manomissione (MAC invalido,
  decrypt da terzi non correlati).
- **Test, stile `FakeLightningNetwork`**: `packages/escrow/src/testing/nwc-fake-relay.ts`
  fornisce un relay in-memory (bus pub/sub) e un `FakeNwcWalletService` che
  parla il protocollo NWC per davvero (firma eventi, cifra/decifra NIP-04 e
  NIP-44, costruisce bolt11 "abbastanza veri" col tag `p` corretto) ma è
  sostenuto dalla STESSA `FakeLightningNetwork` usata dagli altri test
  dell'escrow — nessuna rete vera, nessun mock che risponde "quello che serve
  al test": le meccaniche di stato (open→held→settled/cancelled, saldi che si
  muovono solo su settle/cancel) sono quelle vere. `nwc.test.ts` copre l'intero
  ciclo di vita hold (funding → held → settle, e il ramo cancel/refund), il
  fallback di cifratura, l'assenza di hold support, timeout ed eventi
  falsificati da un relay non fidato.
- **Validazione della connection string**: `nostr+walletconnect://<pubkey
hex a 32 byte>?relay=wss://...&secret=<hex a 32 byte>` con almeno un
  `relay=` (ws/wss) — verificata in `parseNwcUri`, riusata sia dal probe che
  dai test.

## 7. Verifica non fatta (dichiarata, non finta)

Tutto quanto sopra è verificato contro il relay/wallet finto in-process
(nessuna rete reale è raggiungibile in questo ambiente di sviluppo). **Non è
stato verificato contro un wallet NWC reale** (Alby Hub o altro): la codifica
NIP-44/NIP-04 segue esattamente lo pseudocodice della spec e i test di
round-trip la validano internamente, ma solo un'interoperabilità reale la
conferma end-to-end. Percorso di verifica rimandato: connettere un'istanza
Alby Hub (o altro wallet NWC hold-invoice-capable) su regtest/testnet e
ripetere il ciclo funding→held→settle di `nwc.test.ts` contro di essa, prima
del mainnet — annotato anche in `apps/web/README.md`.

## 8. Conseguenze

- Chiude il roadmap item di ADR-013: i tre adapter previsti da ESCROW.md §5
  (`fake`, `lnd_rest`, `nwc`) sono ora tutti implementati.
- Zero custodia invariata: l'adapter NWC chiede solo al wallet dell'utente di
  agire (firma i propri eventi, mai quelli altrui; il coordinatore continua a
  detenere solo preimage).
- Il campo `wallet_connections.capabilities` (già prima previsto dallo schema
  ma finora sempre scritto `{holdInvoice:true}` a prescindere) ora riflette
  un probe reale per NWC: `{holdInvoice, encryption}`.
