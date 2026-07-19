#!/usr/bin/env bash
#
# Mercurio — backup dello stato di produzione (ADR-024 §10).
#
# Salva le due cose che non si possono ricostruire: il database e i blob delle
# foto. NON salva COORDINATOR_KEY, che vive in .env e va custodita FUORI da
# questo host: un dump ripristinato senza quella chiave restituisce wallet che
# non si riaprono e hold che non si possono più rilasciare (ADR-013).
#
# Uso:
#   ./infra/production/backup.sh [destinazione]      # default: ./backups
#
# Da cron, ogni notte alle 3:
#   0 3 * * * cd /srv/mercurio && ./infra/production/backup.sh /var/backups/mercurio >> /var/log/mercurio-backup.log 2>&1
#
# Il ripristino è in docs/DEPLOY.md.

set -euo pipefail

COMPOSE="docker compose -f $(dirname "$0")/docker-compose.yml"
DEST="${1:-./backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$DEST"

# Le credenziali non servono qui: il container Postgres ha già le proprie in
# ambiente, quindi non c'è nessuna password da passare (né da far comparire
# nella riga di comando, dove chiunque legga `ps` la vedrebbe).
echo "==> Postgres → $DEST/postgres-$STAMP.dump"
$COMPOSE exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' \
  >"$DEST/postgres-$STAMP.dump"

# I blob si leggono dal container dell'API, che monta già il volume: così il
# nome del volume non è duplicato qui. Sono content-addressed e immutabili
# (ADR-020), quindi copiarli a caldo è sicuro: nessun blob cambia sotto i piedi.
# Il percorso sta dentro `sh -c` come sopra: fuori, una shell Git-Bash lo
# tradurrebbe in un percorso Windows prima ancora che Docker lo veda.
echo "==> Foto → $DEST/photos-$STAMP.tar.gz"
$COMPOSE exec -T api sh -c 'tar -czf - -C /var/lib/mercurio/photos .' \
  >"$DEST/photos-$STAMP.tar.gz"

# Le foto del locale (ADR-028) vivono su un volume separato: backup separato.
echo "==> Foto del locale → $DEST/venue-photos-$STAMP.tar.gz"
$COMPOSE exec -T api sh -c 'tar -czf - -C /var/lib/mercurio/venue-photos .' \
  >"$DEST/venue-photos-$STAMP.tar.gz"

# Un dump vuoto è un backup che si scopre inutile il giorno del ripristino.
# (Le foto del locale possono legittimamente essere assenti: nessun hub le ha
# ancora caricate — quindi il suo archivio non è nel controllo di non-vuoto.)
for f in "$DEST/postgres-$STAMP.dump" "$DEST/photos-$STAMP.tar.gz"; do
  if [ ! -s "$f" ]; then
    echo "ERRORE: $f è vuoto — backup NON riuscito" >&2
    exit 1
  fi
done

echo
echo "Fatto:"
ls -lh "$DEST/postgres-$STAMP.dump" "$DEST/photos-$STAMP.tar.gz" \
  "$DEST/venue-photos-$STAMP.tar.gz" | sed 's/^/  /'
echo
echo "Ricorda: COORDINATOR_KEY (in .env) va conservata a parte e fuori da questo host."
