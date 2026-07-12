# ADR-002 — Next.js per il web, API pubblica separata su Fastify

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Requisiti: web mobile-first in italiano (i18n pronto per l'inglese), UI secondo la
Bitcoin Design Guide, e **API pubbliche e documentate** perché l'app mobile arriverà
dopo e le integrazioni terze sono benvenute (progetto open source).

## Decisione

- **apps/web**: Next.js (App Router) — SSR per le pagine pubbliche (bacheca, profili
  hub), ottimo supporto i18n (`next-intl`, `it` default), ecosistema maturo.
- **apps/api**: servizio **Fastify** separato. Rotte tipizzate con schemi **Zod**
  (condivisi in `packages/shared`) da cui si genera **OpenAPI** servita su `/docs`.
  Gli handler dei wallet-event (hold pagate/annullate/regolate) e i worker pg-boss
  vivono qui.

Il web consuma la stessa API pubblica (client generato dallo schema): garanzia che
l'API basti davvero per il futuro client mobile, perché è già l'unico client.

## Alternative considerate

- **Solo Next.js (API routes / server actions)**: meno pezzi, ma l'API pubblica
  diventerebbe un cittadino di seconda classe accoppiato al deploy del frontend;
  server actions non producono OpenAPI. Scartato per il requisito API-first.
- **tRPC**: DX eccellente ma contratto non-standard verso terzi; il requisito è
  un'API _pubblica documentata_ → REST+OpenAPI.
- **NestJS**: più struttura di quella che serve; Fastify puro + Zod è più leggero e
  la logica sta comunque in `packages/core`.

## Conseguenze

- Due deploy (web, api) già dall'MVP: costo accettato in cambio di API-first reale.
- Autenticazione via sessione cookie (web) e bearer token (API terzi) sulla stessa app.
- Il contratto OpenAPI è versionato nel repo: le breaking change si vedono nel diff.
