// @mercurio/api - public REST API (Fastify + OpenAPI on /docs), wallet-event
// pump and pg-boss workers (ADR-002, ADR-011).
//
// This is the only place where domain effects are executed (DB writes,
// coordinator calls, outbox emails) - the domain itself lives in
// @mercurio/core and is pure.

import { buildApp } from './app';
import { startWorkers } from './worker';

const app = buildApp();
const port = Number(process.env.PORT ?? 3001);

app
  .listen({ port, host: '0.0.0.0' })
  .then(async () => {
    // Workers share the API process in the MVP (ARCHITECTURE.md §3);
    // RUN_WORKERS=false detaches them (e.g. when running several replicas).
    if (process.env.RUN_WORKERS !== 'false') {
      await startWorkers({
        lifecycle: app.lifecycle,
        sendMail: app.sendMail,
        connectionString:
          process.env.DATABASE_URL ?? 'postgres://mercurio:mercurio@localhost:5432/mercurio',
      });
      app.log.info('pg-boss workers started');
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
