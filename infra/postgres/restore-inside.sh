#!/bin/sh
# In-container half of restore.sh: replace PGDATA with base backup <id> and configure WAL replay from /wal.
#   restore-inside.sh <id|latest> [target-time ISO-8601]
set -eu
ID=$1
[ "$ID" = latest ] && ID=$(cat /backups/latest)
SRC=/backups/$ID
[ -f "$SRC/BACKUP_OK" ] || { echo "restore: $SRC is not a complete backup" >&2; exit 1; }
PGDATA=${PGDATA:-/var/lib/postgresql/data}
find "$PGDATA" -mindepth 1 -delete
tar -xzf "$SRC/base.tar.gz" -C "$PGDATA"
mkdir -p "$PGDATA/pg_wal"
tar -xzf "$SRC/pg_wal.tar.gz" -C "$PGDATA/pg_wal"
# A base backup of a previously restored server carries that restore's settings: drop them, or an old
# recovery_target_time would silently cut this replay short.
sed -i -E '/^[[:space:]]*(restore_command|recovery_target[a-z_]*)[[:space:]]*=/d' "$PGDATA/postgresql.auto.conf" 2>/dev/null || true
{
  echo "restore_command = 'cp /wal/%f %p'"
  echo "recovery_target_action = 'promote'"
  if [ -n "${2:-}" ]; then echo "recovery_target_time = '$2'"; fi
} >> "$PGDATA/postgresql.auto.conf"
touch "$PGDATA/recovery.signal"
chown -R postgres:postgres "$PGDATA"
chmod 700 "$PGDATA"
echo "restore: base backup $ID unpacked; WAL replay ${2:+to $2 }starts with the database"
