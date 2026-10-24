#!/bin/sh
# Container entrypoint: bring the schema to the latest migration, then hand PID 1 to uvicorn.
set -eu
python scripts/migrate.py
# Forwarded client IPs (rate limits, lockout) are trusted only from loopback and private networks, i.e. the nginx
# container on the compose network; a client-supplied X-Forwarded-For from anywhere else is ignored.
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers   --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"
