#!/usr/bin/env bash
# Pre-deploy Postgres snapshot. Called only when the deploy delta
# includes a new SQL migration — the nightly cron handles routine
# snapshots, this one captures the exact "right before this set of
# migrations ran" state for fast forward-recovery if a migration goes
# wrong.
#
# Dumps land under $DEPLOY_DIR/backups/<sha>.sql.gz (team-owned, no
# sudo needed for the file write). The actual pg_dump still runs
# inside the postgres container via `sudo -n docker exec` so we don't
# need a postgresql-client install on the host.
#
# Retention here is independent of /var/backups/oddzilla — keep the
# last 2 pre-deploy snapshots. The /var/backups/oddzilla cron is the
# durable history line; this dir only needs to support "roll back the
# deploy I just did" without the per-dump ~3 GB starving the disk.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

if [ "$#" -lt 1 ]; then
  err "usage: dump-db.sh <sha>"
  exit 2
fi

SHA="$1"
RETENTION="${PRE_DEPLOY_BACKUP_RETENTION:-2}"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"

deploy_ensure_dirs

# Read just the postgres credentials. Same shape as pg_backup.sh — we
# do NOT `set -a; . .env` because that would dump JWT_SECRET +
# ODDIN_TOKEN + HD_MASTER_MNEMONIC into our environment, where any
# concurrent process could read them out of /proc/<pid>/environ.
read_env_var() {
  local key="$1"
  local default="${2:-}"
  local v=""
  if [ -f "${ENV_FILE}" ]; then
    v=$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true)
  fi
  printf '%s' "${v:-${default}}"
}

POSTGRES_USER=$(read_env_var POSTGRES_USER oddzilla)
POSTGRES_DB=$(read_env_var POSTGRES_DB oddzilla)
POSTGRES_PASSWORD=$(read_env_var POSTGRES_PASSWORD)

if [ -z "${POSTGRES_PASSWORD}" ]; then
  err "POSTGRES_PASSWORD missing in ${ENV_FILE}"
  exit 1
fi

DUMP="${DEPLOY_BACKUP_DIR}/${SHA}.sql.gz"

log "dumping pg to ${DUMP}"

# Password is passed only into the container's env (-e), never into
# the host shell environment. The dump streams over the docker exec
# pipe straight into gzip on the host so the postgres container never
# writes the dump to its own (mem-limited) filesystem.
#
# `gzip -1` instead of `-9` because the previous setting put gzip on a
# single host core and pg_dump blocked on Client/ClientWrite — backups
# of the 13 GB raw dump (mostly `odds_history_default`) took ~13 min on
# CPX31. `-1` is ~5x faster (gzip drains pg_dump at line rate) and the
# output is only ~10% larger (3.4 GB → ~3.8 GB), well within the 2-file
# rotation retention. The dump is a defensive snapshot before
# migrations, not long-term storage — favouring time-to-recover over
# disk efficiency is the right trade.
sudo -n docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  oddzilla-postgres-1 \
  pg_dump \
    --host=127.0.0.1 --port=5432 \
    --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
    --no-owner --clean --if-exists \
  | gzip -1 > "${DUMP}"

unset POSTGRES_PASSWORD

chmod 640 "${DUMP}"

# Rotation: keep the N most recent files, drop the rest. Sort by
# mtime, newest first, skip the head, delete the tail.
mapfile -t old < <(ls -1t "${DEPLOY_BACKUP_DIR}"/*.sql.gz 2>/dev/null | tail -n +"$((RETENTION + 1))" || true)
for f in "${old[@]:-}"; do
  [ -f "${f}" ] && rm -f -- "${f}"
done

bytes=$(stat -c %s "${DUMP}")
log "dump complete: ${DUMP} (${bytes} bytes)"
