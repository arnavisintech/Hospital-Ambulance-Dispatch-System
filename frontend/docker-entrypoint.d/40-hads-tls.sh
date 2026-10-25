#!/bin/sh
# Runs before nginx starts (nginx image convention). With a certificate in /etc/nginx/certs, serve the app on
# 443 with HSTS and redirect HTTP; without one, serve the app on plain HTTP (local / behind a TLS terminator).
set -eu
CERT=/etc/nginx/certs/fullchain.pem
KEY=/etc/nginx/certs/privkey.pem
if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  cat > /etc/nginx/hads/http-mode.conf <<'CONF'
location / { return 301 https://$host$request_uri; }
CONF
  cat > /etc/nginx/conf.d/hads-tls.conf <<'CONF'
server {
  listen 443 ssl;
  http2 on;
  server_name _;
  ssl_certificate /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_cache shared:hads_tls:10m;
  include /etc/nginx/hads/app.conf;
}
CONF
  # Through security-headers.conf, so locations with their own add_header send it too.
  echo 'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;' > /etc/nginx/hads/hsts.conf
  echo "hads: HTTPS enabled"
else
  echo "include /etc/nginx/hads/app.conf;" > /etc/nginx/hads/http-mode.conf
  rm -f /etc/nginx/conf.d/hads-tls.conf
  echo "# no certificate: no HSTS" > /etc/nginx/hads/hsts.conf
  echo "hads: no certificate in /etc/nginx/certs, serving HTTP only"
fi
