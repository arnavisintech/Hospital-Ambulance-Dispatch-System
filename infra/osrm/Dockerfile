# OSRM data-prep image: the official OSRM toolchain + osmium (clipping) + curl (download).
# Used only by the one-shot `osrm-prep` compose service; the router itself runs the stock image.
ARG OSRM_IMAGE=osrm/osrm-backend:v5.25.0
FROM ${OSRM_IMAGE}

# The OSRM images are Debian based. Older Debian releases move to archive.debian.org once out of support,
# so fall back to the archive mirror when the regular mirrors no longer carry this release.
RUN set -eux; \
    if ! apt-get update; then \
      sed -i -e 's|deb.debian.org|archive.debian.org|g' -e 's|security.debian.org|archive.debian.org|g' \
             -e '/-updates/d' /etc/apt/sources.list; \
      apt-get -o Acquire::Check-Valid-Until=false update; \
    fi; \
    apt-get install -y --no-install-recommends osmium-tool curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

COPY prepare.sh /usr/local/bin/prepare.sh
# strip carriage returns in case of a Windows (CRLF) checkout, then make executable
RUN tr -d '\r' < /usr/local/bin/prepare.sh > /tmp/prepare.sh && mv /tmp/prepare.sh /usr/local/bin/prepare.sh \
    && chmod +x /usr/local/bin/prepare.sh
ENTRYPOINT ["/usr/local/bin/prepare.sh"]
