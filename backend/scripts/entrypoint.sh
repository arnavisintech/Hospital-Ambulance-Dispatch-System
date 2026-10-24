#!/bin/sh
# Container entrypoint: bring the schema to the latest migration, then hand PID 1 to uvicorn.
set -eu
python scripts/migrate.py
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS:-*}"
