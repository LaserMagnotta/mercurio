# ADR-032 — Orari dell'hub: intervalli multipli per giorno

- Stato: accettato e implementato — 2026-07-18
- Contesto: CLAUDE.md «Hub — dettagli» (orari di apertura tra i vincoli
  dichiarati alla registrazione); Fase 2 punto 5 del backlog UX (prima
  implementazione, un solo intervallo testuale per giorno/intervallo di
  giorni); segnalazione diretta di Giacomo — molti hub reali (bar, negozi)
  chiudono a pranzo e un solo intervallo per giorno non li rappresenta.

## Contesto

La primissima implementazione degli orari (Fase 2 punto 5) salvava
`opening_hours` come un oggetto libero `{ chiave: stringa }` — chiavi giorno
singolo (`mon`) o range (`mon-sat`), valore un testo tipo `"08:00-20:00"`
scritto a mano dall'hub. Due limiti concreti:

1. **un solo intervallo per giorno**: un hub con la pausa pranzo non poteva
   dichiararlo — doveva mentire con un intervallo unico che copre anche la
   pausa, o lasciare il campo vuoto.
2. **nessuna struttura**: il valore era testo libero senza validazione, con
   il rischio che form diversi (o client futuri) producessero formati non
   confrontabili tra loro.

## Decisione

**Un array di intervalli `{ day, opens, closes }`, un elemento per intervallo
aperto.** Un giorno con la pausa pranzo è semplicemente due elementi con lo
stesso `day`:

```json
[
  { "day": "mon", "opens": "08:00", "closes": "12:30" },
  { "day": "mon", "opens": "15:00", "closes": "19:30" },
  { "day": "sat", "opens": "08:00", "closes": "13:00" }
]
```

Un giorno assente è chiuso. Questa è la forma che **schema.org**
(`OpeningHoursSpecification`, usata anche da Google Business Profile) adotta
per lo stesso problema — non è stata inventata da zero: una riga per
intervallo è l'unico modo pulito di rappresentare un turno spezzato senza un
mini-linguaggio a stringa (l'alternativa nota è la sintassi `opening_hours`
di OpenStreetMap, scartata qui perché richiede un parser/serializer dedicato
solo per poter editare un turno spezzato da un form — sproporzionato per
questo caso d'uso interno).

`day` resta uno degli otto codici già in uso nell'i18n (`mon`…`sun`,
`DAY_KEYS` in `@mercurio/shared`), non i nomi completi di schema.org: zero
motivo di cambiare una convenzione già usata dai cataloghi `it.json`/
`en.json`.

### Validazione (`openingHoursDto`, `@mercurio/shared`)

- `opens`/`closes` in formato `HH:MM` 24h (lo stesso che produce
  `<input type="time">`, nessun parsing lato client);
- `opens < closes` per ogni intervallo;
- al più `MAX_OPENING_INTERVALS_PER_DAY` (3) intervalli per giorno — non
  esattamente 2: la pausa pranzo è il caso comune, un terzo intervallo resta
  margine per un caso raro senza dover alzare un limite rigido più avanti;
- nessuna sovrapposizione fra intervalli dello stesso giorno.

### Colonna DB invariata

`hubs.opening_hours` resta `jsonb` — cambia solo la forma del valore che ci
si scrive dentro, validata al bordo API (`openingHoursDto` in
`POST /me/roles/hub`) e non dallo schema Postgres. Nessuna migrazione: zero
hub reali erano registrati oltre ai dati seed, quindi non serve un backfill.

### UI

Il form di registrazione (`HubRegisterForm`) mostra ogni giorno con i suoi
intervalli come coppie di `<input type="time">` più un pulsante "Rimuovi";
un pulsante "+ Aggiungi intervallo" per giorno (nascosto oltre il tetto).
La lettura (`OpeningHours`, hub card e board) raggruppa gli intervalli per
giorno e collassa giorni consecutivi con lo stesso identico orario in una
riga sola ("Lun–Ven 08:00–12:30, 15:00–19:30") — la stessa compattezza che
prima veniva dalle chiavi-range, ora calcolata a lettura invece che imposta
in scrittura.

## Conseguenze

- Nessun movimento di denaro: la modifica non tocca escrow/ledger.
- I tre hub seed (`packages/db/src/seed-data.ts`) sono stati riscritti nel
  nuovo formato; uno di loro (Tabaccheria Giulia) dichiara un vero turno
  spezzato, cosicché il caso resti coperto ogni volta che il DB dev si
  reinizializza.
- Debito noto: non esiste ancora una rotta per **modificare** gli orari dopo
  la registrazione (vale per l'intero profilo hub, non solo per gli orari) —
  fuori scope qui.
