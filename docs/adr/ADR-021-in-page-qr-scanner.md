# ADR-021 — Scanner QR in pagina: BarcodeDetector nativo, campo testo come fallback universale

- Stato: accettato e implementato — 2026-07-17
- Contesto: ADR-018 §6 (campi QR tolleranti, `parseQrInput`), ADR-016 (il
  destinatario mostra il proprio token come QR), ADR-020 §2 (pattern "decisione
  di piattaforma → piccolo ADR"), CLAUDE.md (mobile-first, l'operatore hub usa
  il telefono; Bitcoin Design Guide)

## Contesto

Ogni passaggio di mano si identifica con il QR sul pacco (ARCHITECTURE §7: il QR
identifica, non autorizza). Finora i tre punti in cui si "digita" un QR —
check-in/checkout/arrivo/riconsegna lato hub (`HubOpsClient`), conferma del
vettore (`CarrierActions`) e il token di claim del destinatario
(`HubOpsClient`, ADR-016) — erano **solo un campo di testo**: uno scanner
hardware o l'app fotocamera del telefono incollano l'URL `/p/<token>`, un
operatore digita il token nudo, e `parseQrInput` (ADR-018 §6) tollera entrambe
le forme. Funziona, ma costringe l'operatore a uscire dall'app, scansionare
altrove e tornare a incollare — attrito su un gesto che si ripete a ogni pacco.

Serve poter inquadrare il QR **dentro la pagina**. La domanda tecnica non è
"come apro la fotocamera" (è `getUserMedia`), ma **come decodifico il QR** e
quanto peso siamo disposti a spendere per farlo su ogni browser.

Il vincolo che governa la scelta: **il campo di testo non si rimuove mai**. È
l'universale — copre scanner hardware, app fotocamera di sistema, incolla e
digitazione manuale — e funziona su qualunque browser. Lo scanner in pagina è
un *miglioramento progressivo* sopra a quel campo, non un rimpiazzo.

## Decisione

### 1. Decodifica: `BarcodeDetector` nativo dove c'è, nessuna libreria nel bundle

La UI decodifica con la **Barcode Detection API** del browser
(`new BarcodeDetector({ formats: ['qr_code'] })`): zero peso aggiunto al
bundle, decodifica accelerata dalla piattaforma. Dove l'API non esiste, **non
si carica nessun decoder JavaScript**: si degrada al campo di testo (che è già
lì) più l'app fotocamera del dispositivo.

Perché *non* impacchettare `jsQR` (~40 KB) o `@zxing/browser` (più pesante,
trascina dipendenze) come fallback:

- Il caso "browser senza `BarcodeDetector`" è **già coperto** dal campo testo +
  fotocamera di sistema. Aggiungere un decoder pesa su **tutti** i download per
  servire una minoranza che ha comunque una via d'uscita funzionante.
- Il primo bersaglio mobile-first — l'operatore hub, il mittente, il vettore
  sul telefono — è in larga parte **Android/Chrome**, dove `BarcodeDetector`
  c'è: la scansione in pagina funziona senza costare un byte in più.
- Coerente con l'orientamento lean del progetto: niente peso "per sicurezza".

Il confine che rende reversibile la scelta è il **componente `QrScanInput`**
(stesso spirito dell'interfaccia `BlobStore` di ADR-020): se un domani i dati
sul campo mostrassero che gli operatori iOS/desktop hanno davvero bisogno della
scansione in pagina, aggiungere `@zxing/browser` come polyfill del decoder è un
cambiamento **localizzato dentro `QrScanInput`**, non un refactoring dei form.
Finché non c'è quel dato, non si paga quel peso.

### 2. Matrice di supporto (perché il fallback è accettabile, non pigro)

| Browser / piattaforma            | `BarcodeDetector` | Scansione in pagina | Fallback                    |
| -------------------------------- | ----------------- | ------------------- | --------------------------- |
| Chrome/Edge su **Android**       | sì                | ✅                  | —                           |
| Chrome/Edge su ChromeOS, macOS   | sì                | ✅                  | —                           |
| Chrome/Edge su **Windows/Linux** | no (nessun backend) | ❌                | campo testo + app fotocamera |
| **Safari** (iOS/macOS)           | no                | ❌                  | campo testo + Fotocamera iOS |
| **Firefox** (tutte)              | no                | ❌                  | campo testo                 |

Il bersaglio che conta di più — il telefono Android dell'operatore hub — è nel
sì. Su iOS l'app Fotocamera di sistema riconosce il QR (e può aprire l'URL
`/p/<token>`); l'operatore incolla il risultato. Su desktop resta lo scanner
hardware o l'incolla. Il campo di testo copre tutti gli altri, sempre.

Il supporto si accerta **a runtime, lato client, dopo il mount**
(`BarcodeDetector.getSupportedFormats()` deve includere `qr_code`): SSR e primo
render client concordano su "non supportato" (nessun mismatch di idratazione),
e il bottone "Scansiona" **compare solo dove la scansione funziona davvero** —
niente promesse che il browser non può mantenere.

### 3. Privacy: lo stream non lascia mai il dispositivo

Non negoziabile e verificabile nel codice:

- Il flusso video vive solo in un `<video>` locale; la decodifica
  (`BarcodeDetector`) gira **sul dispositivo**. Nessun frame viene salvato,
  messo in canvas persistente o inviato a un endpoint.
- Alla prima decodifica riuscita, alla chiusura del riquadro o allo smontaggio
  del componente si chiama `track.stop()` su **ogni** traccia e si stacca lo
  `srcObject`: la spia della fotocamera si spegne, nessun frame sopravvive alla
  scansione.
- Nessun dato di posizione o metadato entra in gioco (a differenza delle foto
  di ADR-020, qui non si carica nulla: si legge solo una stringa dal QR).

### 4. `QrScanInput`: un componente riusabile, neutro sul contratto dei form

Un solo componente rende i tre punti di scansione (ADR-018 §6):

- Renderizza **il campo di testo di sempre** (label + input + hint) e, dove
  supportato, un bottone "Scansiona con la fotocamera" che apre un riquadro di
  mira a tutta larghezza (mobile-first), con **torcia** se la traccia la
  espone (`getCapabilities().torch`) e **camera posteriore** preferita
  (`facingMode: { ideal: 'environment' }`).
- Alla decodifica **riempie il campo con la stringa grezza**, esattamente come
  se l'operatore l'avesse incollata: il form padre continua a possedere il
  valore e a farne ciò che già faceva — `parseQrInput` per il QR del pacco, il
  token nudo per il claim (ADR-016). Il componente aggiunge **un modo di
  riempire il campo, non un nuovo campo**: nessun contratto di form cambia.
- Gestisce con copy chiara e ritorno al campo testo i casi: **connessione non
  sicura** (serve https; su `localhost` la scansione va), **permesso negato**,
  **nessuna fotocamera**, **errore generico**. Il mapping errore→copy è una
  funzione pura (`lib/qr-scan-error.ts`) con unit test, così le vie di
  degradazione sono coperte anche dove la fotocamera non esiste (CI).
- È client-only ma tocca `navigator.mediaDevices`/`BarcodeDetector` **solo
  dentro effetti e handler**, mai al render/import: server-renderizza senza
  `next/dynamic` (a differenza di Leaflet in ADR-018 §4, la cui libreria tocca
  `window` all'import).

### 5. Integrazione

- `HubOpsClient`: il campo QR del pacco (check-in, checkout, arrivo,
  riconsegna, ritiro/OTP, claim) diventa `QrScanInput`; anche il **campo token
  di claim** — che il destinatario mostra come QR del token nudo (ADR-016) —
  usa `QrScanInput`, così l'operatore può inquadrarlo dal dispositivo del
  destinatario.
- `CarrierActions`: il campo QR della conferma vettore diventa `QrScanInput`.
- L'OTP resta un campo di testo: è un codice via email, non un QR.

## Alternative considerate

- **`jsQR` / `@zxing/browser` nel bundle come fallback universale**: peso su
  ogni download per un caso già coperto dal campo testo; scartato per l'MVP,
  reversibile dietro `QrScanInput` se i dati lo chiederanno (§1).
- **Solo campo testo, nessuno scanner** (status quo): attrito a ogni pacco,
  proprio sul telefono dove `BarcodeDetector` è disponibile. Scartato: il
  miglioramento è gratis dove serve di più.
- **Caricare un frame/foto del QR all'API per decodificarlo server-side**:
  manda immagini della fotocamera al server per nulla — contro la
  minimizzazione (RISKS §6) e inutile, la decodifica è locale. Scartato.
- **`next/dynamic` `ssr:false` per il componente**: non serve, il componente
  non tocca `window` al render (§4); complessità inutile.

## Conseguenze

- Su Android/Chrome (e ChromeOS/macOS) l'operatore inquadra il QR in pagina;
  altrove il campo di testo e l'app fotocamera restano la via — sempre
  funzionante, mai promessa a vuoto.
- Il bundle web non cresce: nessuna dipendenza di decodifica aggiunta.
- Aggiungere un decoder JS (per iOS/desktop) in futuro è una modifica dentro
  `QrScanInput`, non nei form: il componente è il confine, come `BlobStore`
  in ADR-020.
- Tipi mancanti in `lib.dom` (`BarcodeDetector`, `torch`) sono dichiarati in un
  piccolo shim ambientale (`apps/web/types/webapis.d.ts`), limitato alla
  superficie usata.
