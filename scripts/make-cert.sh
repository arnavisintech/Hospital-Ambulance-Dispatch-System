#!/bin/sh
# Self-signed certificate for testing HTTPS locally (browsers will warn). Real deployments use a CA-issued cert.
#   ./scripts/make-cert.sh [hostname]      -> certs/fullchain.pem, certs/privkey.pem
set -eu
HOST="${1:-localhost}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/certs"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$HOST" \
  -addext "subjectAltName=DNS:$HOST,IP:127.0.0.1" -keyout "$DIR/privkey.pem" -out "$DIR/fullchain.pem"
echo "Wrote $DIR/fullchain.pem and $DIR/privkey.pem"
