#!/usr/bin/env bash
# One-shot OSRM data preparation for the HADS Chennai pilot (docker-compose service `osrm-prep`).
#
#   1. download the Geofabrik India "southern zone" extract (resumable, retried)
#   2. clip it to the Chennai metro bounding box with osmium
#   3. osrm-extract (car profile) -> osrm-partition -> osrm-customize   (MLD pipeline)
#
# Idempotent: when the finished dataset (marker file) already exists in $DATA_DIR the script exits immediately,
# so `docker compose up` after the first run costs nothing. Delete the volume (or the marker) to rebuild.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
PBF_URL="${PBF_URL:-https://download.geofabrik.de/asia/india/southern-zone-latest.osm.pbf}"
BBOX="${BBOX:-79.95,12.75,80.40,13.30}"          # min_lon,min_lat,max_lon,max_lat (Chennai metro)
NAME="${OSRM_NAME:-chennai}"
PROFILE="${OSRM_PROFILE:-/opt/car.lua}"
THREADS="${OSRM_THREADS:-$(nproc 2>/dev/null || echo 2)}"
KEEP_SOURCE="${KEEP_SOURCE:-false}"              # keep the ~600 MB regional pbf after clipping?

SRC="$DATA_DIR/southern-zone-latest.osm.pbf"
CLIP="$DATA_DIR/$NAME.osm.pbf"
BASE="$DATA_DIR/$NAME.osrm"
MARKER="$DATA_DIR/$NAME.osrm.ready"

log() { printf '[osrm-prep %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

mkdir -p "$DATA_DIR"

if [[ -f "$MARKER" && -f "$BASE.mldgr" && -f "$BASE.cell_metrics" && -f "$BASE.partition" ]]; then
  log "dataset already prepared ($(cat "$MARKER")); nothing to do"
  exit 0
fi

for tool in curl osmium osrm-extract osrm-partition osrm-customize; do
  command -v "$tool" >/dev/null 2>&1 || { log "missing required tool: $tool"; exit 1; }
done
[[ -f "$PROFILE" ]] || { log "OSRM profile not found: $PROFILE"; exit 1; }

# 1. download (skip if a complete clip already exists, e.g. a previous run died during extract)
if [[ ! -s "$CLIP" ]]; then
  if [[ ! -s "$SRC" ]]; then
    log "downloading $PBF_URL"
    # curl's own --retry does not cover a dropped connection mid-transfer (exit 18), so resume in a loop.
    attempt=1
    until curl -fL --retry 5 --retry-delay 10 --connect-timeout 30 --speed-limit 1024 --speed-time 120 \
               -C - -o "$SRC.part" "$PBF_URL"; do
      rc=$?
      if (( attempt >= ${DOWNLOAD_ATTEMPTS:-20} )); then
        log "download failed after $attempt attempts (curl exit $rc)"; exit "$rc"
      fi
      log "download interrupted (curl exit $rc); resuming, attempt $((++attempt))"
      sleep 5
    done
    mv "$SRC.part" "$SRC"
  else
    log "using cached $(basename "$SRC")"
  fi
  log "verifying $(basename "$SRC")"
  osmium fileinfo "$SRC" >/dev/null

  # 2. clip to Chennai; complete_ways keeps roads that cross the bbox edge routable
  log "clipping to bbox $BBOX"
  osmium extract --bbox "$BBOX" --strategy complete_ways --overwrite -o "$CLIP.tmp.osm.pbf" "$SRC"
  mv "$CLIP.tmp.osm.pbf" "$CLIP"
  if [[ "$KEEP_SOURCE" != "true" ]]; then
    rm -f "$SRC"
  fi
fi
log "clip ready: $(du -h "$CLIP" | cut -f1)"

# 3. OSRM MLD pipeline (writes $NAME.osrm.* next to the clip)
rm -f "$MARKER"
log "osrm-extract (profile $(basename "$PROFILE"), $THREADS threads)"
osrm-extract -p "$PROFILE" -t "$THREADS" "$CLIP"
log "osrm-partition"
osrm-partition -t "$THREADS" "$BASE"
log "osrm-customize"
osrm-customize -t "$THREADS" "$BASE"

date -u +"prepared %Y-%m-%dT%H:%M:%SZ from $(basename "$PBF_URL") bbox $BBOX" > "$MARKER"
log "done: $(cat "$MARKER")"
