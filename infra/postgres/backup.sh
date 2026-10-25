#!/bin/sh
# One base backup into /backups/<id>/ (tar + gzip, WAL streamed), mark it complete, point `latest` at it, keep
# the newest BACKUP_KEEP (default 7) and delete archived WAL older than the oldest kept backup.
set -eu
KEEP=${BACKUP_KEEP:-7}
ID=$(date -u +%Y%m%dT%H%M%SZ)
DIR=/backups/$ID
mkdir -p "$DIR"
touch "$DIR/STARTED"          # WAL archived before this moment is not needed by this backup
pg_basebackup -h "${PGHOST:-db}" -U "${PGUSER:-hads}" -D "$DIR" -Ft -z -X stream -c fast --label "hads-$ID"
touch "$DIR/BACKUP_OK"
echo "$ID" > /backups/latest.tmp && mv /backups/latest.tmp /backups/latest
# prune old backups (only complete ones count towards KEEP)
ls -1d /backups/*/BACKUP_OK 2>/dev/null | sed 's#/BACKUP_OK##' | sort | head -n "-$KEEP" | while read -r old; do
  rm -rf "$old"
done
OLDEST=$(ls -1d /backups/*/BACKUP_OK 2>/dev/null | sed 's#/BACKUP_OK##' | sort | head -n 1)
if [ -n "$OLDEST" ] && [ -d /wal ]; then
  # timeline .history files are tiny and needed by any later point-in-time recovery: never prune them
  find /wal -type f ! -name '*.history' ! -newer "$OLDEST/STARTED" -mmin +60 -delete
fi
echo "backup: $ID complete ($(du -sh "$DIR" | cut -f1)); keeping $KEEP"
