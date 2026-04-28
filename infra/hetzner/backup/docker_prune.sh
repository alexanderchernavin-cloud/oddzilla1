#!/usr/bin/env bash
# Daily Docker housekeeping. Runs from root's crontab.
#
# What it cleans (safe — never touches running containers, named volumes,
# or images currently in use by a container):
#   1. Build cache when total > BUILD_CACHE_THRESHOLD_GB. Build cache
#      regenerates on the next `docker compose build` so this is free.
#   2. Dangling images (untagged orphans) older than 24h.
#   3. Stopped containers older than 7 days (defensive — prod containers
#      are restart=always so this should rarely match).
#
# What it does NOT touch:
#   - Running containers
#   - Named volumes (postgres_data, redis_data, caddy_data, etc.)
#   - Images currently referenced by any container (running or stopped)
#   - Build cache below the threshold (so iterative rebuilds stay fast)
#
# History — added 2026-04-28 after disk filled to 100% with 43 GB of
# accumulated build cache, taking postgres down for 6 days. The threshold
# is intentionally low (10 GB) because every `docker compose build` on
# this CPX22 (75 GB disk) adds ~1-2 GB of layers.

set -euo pipefail

BUILD_CACHE_THRESHOLD_GB="${BUILD_CACHE_THRESHOLD_GB:-10}"

# Total build cache size in bytes. `docker system df --format` returns
# human-readable strings ("43.75GB"); easier to parse the raw API.
build_cache_bytes=$(docker system df --verbose --format '{{json .}}' \
  | python3 -c '
import json, sys
data = json.load(sys.stdin)
total = 0
for entry in data.get("BuildCache", []):
    total += entry.get("Size", 0)
print(total)
')

threshold_bytes=$((BUILD_CACHE_THRESHOLD_GB * 1024 * 1024 * 1024))

if [ "${build_cache_bytes}" -gt "${threshold_bytes}" ]; then
  reclaimed=$(docker builder prune -af 2>&1 | tail -1 | awk '{print $NF}')
  printf '{"service":"docker-prune","event":"build_cache_pruned","before_bytes":%d,"threshold_bytes":%d,"reclaimed":"%s"}\n' \
    "${build_cache_bytes}" "${threshold_bytes}" "${reclaimed}"
else
  printf '{"service":"docker-prune","event":"build_cache_under_threshold","bytes":%d,"threshold_bytes":%d}\n' \
    "${build_cache_bytes}" "${threshold_bytes}"
fi

# Dangling (untagged orphan) images, older than 24h.
docker image prune -f --filter 'until=24h' >/dev/null

# Long-stopped containers (defensive — prod uses restart=always).
docker container prune -f --filter 'until=168h' >/dev/null

# Disk-after snapshot for the journal.
disk=$(df -B1 / | awk 'NR==2 {printf "{\"size\":%d,\"used\":%d,\"avail\":%d}", $2, $3, $4}')
printf '{"service":"docker-prune","event":"disk_after","disk":%s}\n' "${disk}"
