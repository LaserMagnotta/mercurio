# ADR-003 — PostgreSQL + Drizzle ORM

- Stato: proposto (in revisione) — 2026-07-12

## Contesto

Il cuore del sistema è contabile: ledger a partita doppia, hold, macchina a stati con
transizioni atomiche "stato + denaro". Servono transazioni serie, vincoli dichiarativi
(CHECK, trigger di bilanciamento), lock pessimisti sui passaggi di stato, e in futuro
query geografiche (PostGIS).

## Decisione

**PostgreSQL 16** come unico datastore (dati, ledger, code pg-boss — ADR-011) e
**Drizzle ORM** come layer di accesso: schema in TypeScript, migrazioni SQL generate e
leggibili, query builder che resta vicino a SQL, controllo esplicito delle transazioni
(`SELECT … FOR UPDATE` sui row di spedizione durante le transizioni).

## Alternative considerate

- **Prisma**: maturo, ma astrae troppo proprio dove serve controllo (transazioni
  interattive più rigide, SQL generato meno ispezionabile, engine binario). Per un
  ledger si vuole vedere l'SQL.
- **Kysely (solo query builder)**: ottimo, ma niente gestione schema/migrazioni
  integrata; Drizzle dà entrambe.
- **SQLite**: insufficiente per lock concorrenti e PostGIS futuro.
- **MySQL/MariaDB**: nessun vantaggio e niente equivalente PostGIS/pg-boss.

## Conseguenze

- Vincoli monetari nel DB, non solo nel codice: trigger `SUM(postings)=0`,
  `amount_msat >= 0` sui saldi, FK ovunque.
- Un solo servizio stateful da gestire in dev e produzione.
- Migrazioni SQL revisionabili nel diff delle PR (coerente con "commit piccoli").
