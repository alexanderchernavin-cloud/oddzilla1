#!/usr/bin/env bash
# Daily Docker housekeeping. Runs from root's crontab.
#
# What it cleans (safe — never touches running containers, named volumes,
# or images currently in use by a container):
#   1. Build cache above MAX_USED_SPACE (default 10 GB). Docker's
#      `buildx prune --max-used-space` handles the threshold internally,
#      so the script does not need to parse `docker system df` output.
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
# History
#   2026-04-28 — added after disk filled to 100% with 43 GB of
#   accumulated build cache, taking postgres down for 6 days.
#
#   2026-05-09 — rewritten after the original Python-based threshold
#   parser silently crashed on every run for ~9 days (Size field is a
#   human-readable string in Docker 29's `system df --format` output,
#   not int bytes), letting cache build back up to 7.9 GB and refilling
#   the disk to 100%. Postgres restart-looped for ~minutes until the
#   build cache was hand-pruned. Two changes in this version:
#     - Drop the broken Python parser; let Docker's --max-used-space
#       handle the threshold (no string-vs-int ambiguity to mishandle).
#     - Trap nonzero exits and write a "failed" JSON event so a future
#       silent failure shows up in /var/log/oddzilla-docker-prune.log
#       even when cron's mail delivery is not configured.

set -euo pipefail

MAX_USED_SPACE_GB="${MAX_USED_SPACE_GB:-10}"
max_used_space_bytes=$((MAX_USED_SPACE_GB * 1024 * 1024 * 1024))

emit() {
  local event="$1"
  shift
  local extras=""
  for kv in "$@"; do
    extras="${extras},${kv}"
  done
  printf '{"service":"docker-prune","event":"%s"%s}\n' "${event}" "${extras}"
}

on_exit() {
  local rc=$?
  if [ "${rc}" -ne 0 ]; then
    emit "failed" "\"exit_code\":${rc}"
  fi
}
trap on_exit EXIT

emit "start" "\"max_used_space_bytes\":${max_used_space_bytes}"

# Build cache above threshold. Docker decides what to evict.
docker buildx prune -af --max-used-space "${max_used_space_bytes}" >/dev/null

# Dangling (untagged orphan) images, older than 24h.
docker image prune -f --filter 'until=24h' >/dev/null

# Long-stopped containers (defensive — prod uses restart=always).
docker container prune -f --filter 'until=168h' >/dev/null

disk=$(df -B1 / | awk 'NR==2 {printf "{\"size\":%d,\"used\":%d,\"avail\":%d}", $2, $3, $4}')
emit "complete" "\"disk\":${disk}"
