# PostgreSQL 16 for HADS: continuous WAL archiving to /wal (pg-wal volume) for point-in-time recovery (NFR6).
# The same image runs the `backup` service (entrypoint loop.sh) and one-off restores (restore-inside.sh).
FROM postgres:16-alpine
RUN mkdir -p /wal /backups && chown postgres:postgres /wal /backups
COPY pg_hba.conf /etc/postgresql/pg_hba.conf
COPY backup.sh loop.sh restore-inside.sh /usr/local/bin/
RUN sed -i 's/\r$//' /usr/local/bin/backup.sh /usr/local/bin/loop.sh /usr/local/bin/restore-inside.sh \
 && chmod +x /usr/local/bin/backup.sh /usr/local/bin/loop.sh /usr/local/bin/restore-inside.sh
CMD ["postgres", \
     "-c", "hba_file=/etc/postgresql/pg_hba.conf", \
     "-c", "wal_level=replica", \
     "-c", "archive_mode=on", \
     "-c", "archive_timeout=60", \
     "-c", "archive_command=test ! -f /wal/%f && cp %p /wal/%f", \
     "-c", "max_wal_senders=4"]
