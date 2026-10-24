#!/bin/sh
# Take a base backup at start (if none exists yet) and then every BACKUP_INTERVAL_H hours (default 24).
set -eu
INTERVAL_S=$(( ${BACKUP_INTERVAL_H:-24} * 3600 ))
until pg_isready -h "${PGHOST:-db}" -U "${PGUSER:-hads}" >/dev/null 2>&1; do sleep 2; done
[ -f /backups/latest ] || backup.sh || echo "backup: initial backup failed; retrying next interval" >&2
while true; do
  sleep "$INTERVAL_S"
  backup.sh || echo "backup: backup failed; retrying next interval" >&2
done
