#!/bin/sh
# Point-in-time restore of the HADS PostgreSQL database. Run on the Docker host from the repository root.
#   scripts/restore-db.sh <backup-id|latest> [--target-time 2026-10-24T10:15:00Z]
# Without --target-time, replays every archived WAL segment (latest committed state, RPO <= archive_timeout).
# Use the same compose files as the running stack, e.g.
#   COMPOSE="docker compose --env-file demo.env -f docker-compose.yml -f docker-compose.demo.yml" scripts/restore-db.sh latest
set -eu
ID=${1:?usage: restore-db.sh <backup-id|latest> [--target-time ISO-8601]}
TARGET=""
if [ "${2:-}" = "--target-time" ]; then TARGET=${3:?--target-time needs a value}; fi
COMPOSE=${COMPOSE:-docker compose}
START=$(date +%s)
# The backend is stopped and restarted around the restore when this project has one (the restore drill has none).
HAS_BACKEND=$($COMPOSE ps -a -q backend 2>/dev/null)

echo "restore: stopping backend and database"
if [ -n "$HAS_BACKEND" ]; then $COMPOSE stop backend; fi
$COMPOSE stop db
echo "restore: unpacking base backup $ID"
$COMPOSE run --rm --no-deps --user root --entrypoint restore-inside.sh db "$ID" "$TARGET"
echo "restore: starting database (WAL replay)"
$COMPOSE start db
i=0
until [ "$($COMPOSE exec -T db psql -U hads -d hads -tAc 'select pg_is_in_recovery()' 2>/dev/null | tr -d '[:space:]')" = "f" ]; do
  i=$((i + 1))
  [ $i -le 600 ] || { echo "restore: database did not finish recovery in 10 minutes" >&2; exit 1; }
  sleep 1
done
if [ -n "$HAS_BACKEND" ]; then
  echo "restore: starting backend"
  $COMPOSE start backend
fi
echo "restore: done in $(( $(date +%s) - START )) s"
