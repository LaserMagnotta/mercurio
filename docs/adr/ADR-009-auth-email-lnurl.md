# ADR-009 — Autenticazione: magic link email obbligatorio, LNURL-auth opzionale

- Stato: **implementato (magic link)** — 2026-07-12
- Analisi identità/Sybil: [RISKS.md](../RISKS.md) §3

## Contesto

Il flusso richiede comunque email funzionanti (notifiche a mittente e destinatario
sono parte della specifica), il pubblico è bitcoin-friendly ma non solo, e il KYC è
fuori discussione. La resistenza agli abusi è economica (bond), non anagrafica.

## Decisione

- **Registrazione con email verificata via magic link** (niente password: niente
  credenziali da custodire, phishing ridotto, e l'email è già il canale operativo).
- **LNURL-auth come metodo di login aggiuntivo opzionale**, collegabile al profilo:
  chiave pubblica del wallet come credenziale, coerente con l'ecosistema e con la
  Bitcoin Design Guide.
- Il destinatario **non deve avere un account**: riceve email con link firmato + OTP
  di ritiro; può creare l'account dopo, se vuole (riduce l'attrito della consegna).
- Sessioni cookie httpOnly per il web; bearer token per l'API pubblica.

## Alternative considerate

- **Solo LNURL-auth**: elegante, ma esclude i non-bitcoiner e non risolve le
  notifiche (l'email servirebbe comunque). Come unico metodo è una barriera.
- **Email + password**: da gestire reset, breach, hashing — costo senza beneficio
  rispetto al magic link per un'app a uso saltuario.
- **OAuth social (Google, ecc.)**: dipendenza da terzi e profilo privacy incoerente
  col progetto.

## Conseguenze

- Un solo canale di identità da minimizzare ai fini GDPR (l'email, già necessaria).
- Gli account usa-e-getta restano possibili: è il bond, non l'identità, a proteggere
  i pacchi (by design).
- L'OTP di ritiro viaggia sull'email del destinatario: la sicurezza della consegna
  dipende dalla casella del destinatario — accettato per l'MVP, documentato nei ToS.

## Parametri concreti (implementazione)

- Token magic-link: validi **15 minuti**, monouso (`consumedAt`), solo l'hash
  SHA-256 è persistito — mai il token in chiaro.
- Sessione: **30 giorni**, cookie httpOnly/sameSite=lax, revocabile (logout,
  cancellazione account); solo l'hash del token di sessione è persistito.
- Anti-abuso: **massimo 5 richieste di magic-link per indirizzo email ogni
  ora** (oltre alla rate-limit generica per IP a livello HTTP).
- Consenso GDPR (RISKS.md §6) richiesto **solo alla primissima verifica** di
  un indirizzo email mai visto prima (creazione account); gli accessi
  successivi non lo richiedono di nuovo.
