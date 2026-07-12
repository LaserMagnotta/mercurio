// @mercurio/api - public REST API (Fastify + OpenAPI), wallet-event handlers
// and pg-boss workers (ADR-002, ADR-011).
//
// This is the only place where domain effects are executed (DB writes,
// coordinator calls, outbox emails) - the domain itself lives in
// @mercurio/core and is pure.

import { buildApp } from './app';

const app = buildApp();
const port = Number(process.env.PORT ?? 3001);

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
