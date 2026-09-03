#!/usr/bin/env bash
# Daily Postgres dump, count-based retention (keep the newest N locally).
# Invoked from root's crontab.
# Dumps run via `docker exec` into the oddzilla-postgres-1 container so the
# host doesn't need postgresql-client installed.
#
# Security notes:
#   • Only the three vars we actually need are read out of .env. The
#     previous `set -a; source .env; set +a` exported every secret in the
#     environment file (JWT_SECRET, ODDIN_TOKEN, future
#     HD_MASTER_MNEMONIC, …) into the cron shell, where any concurrent
#     root process could read /proc/<pid>/environ.
#   • POSTGRES_PASSWORD never touches the host at all: pg_dump runs through
#     a shell INSIDE the postgres container that exports PGPASSWORD from
#     the container's own environment (compose passes it to the image).
#     The host argv carries only the literal "$POSTGRES_PASSWORD". The
#     previous `docker exec -e PGPASSWORD=<value>` form put the real
#     password into `ps` for every local user for the duration of the
#     dump (fixed 2026-09-03, spotted during a deploy).
#   • Dumps written mode 600 root-only.
#   • Optional GPG encryption — set BACKUP_GPG_RECIPIENT (e.g. an
#     off-host operator's pubkey) and the dump is encrypted in addition
#     to gzipped. Dumps are written root:team mode 640 so the `team` SSH
#     login can pull them off-box without sudo — scripts/pull-backup.ps1
#     is the operator's PC-side pull (server has no route to push to a
#     home PC behind NAT).

set -euo pipefail

BACKUP_DIR="/var/backups/oddzilla"
# Keep only the newest N dumps locally (count-based, not mtime). At
# ~4.5 GB/dump this hard-bounds the local footprint to ~N x 4.5 GB even
# if a rotation is ever skipped. The 2026-06-09 outage was a pile-up
# that filled the disk to 100% and crash-looped postgres; older history
# lives off-host. Override via the RETENTION_COUNT env var.
RETENTION_COUNT="${RETENTION_COUNT:-2}"
CONTAINER="oddzilla-postgres-1"
ENV_FILE="/home/team/oddzilla/.env"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# Page on failure. The cron's only output is a JSON line to journal —
# without an explicit alert path, a string of failed backups goes
# unnoticed until someone needs a restore. Paging goes through the shared
# oddzilla-alert-email helper (Resend HTTP API), which is graceful-idle
# when email is unconfigured.
ALERT_CMD="${ALERT_CMD:-/usr/local/bin/oddzilla-alert-email}"
alert_failure() {
    local exit_code="$?"
    if [ "${exit_code}" -eq 0 ]; then return 0; fi
    local hostname_s
    hostname_s=$(hostname)
    printf '{"service":"pg-backup","event":"failed","exit":%d,"host":"%s","ts":"%s"}\n' \
        "${exit_code}" "${hostname_s}" "${TS}" >&2
    if [ -x "${ALERT_CMD}" ]; then
        "${ALERT_CMD}" "pg-backup FAILED" \
            "pg-backup exited ${exit_code} on ${hostname_s} at ${TS}. Disk: $(df -h / | tail -1)." \
            || true
    fi
}
trap alert_failure EXIT

mkdir -p "${BACKUP_DIR}"
# Dir + dumps owned root:team mode 750/640 so the `team` user (operator
# SSH login) can scp dumps to a workstation without sudo. Other local
# users (none today, but defensive) still can't read them.
chown root:team "${BACKUP_DIR}" 2>/dev/null || true
chmod 750 "${BACKUP_DIR}"

# Extract only the postgres credentials we need. Falls back to the same
# defaults that docker-compose.yml uses so a missing var doesn't kill
# the cron silently.
read_env_var() {
    local key="$1"
    local default="${2:-}"
    local v
    v=$(grep -E "^${key}=" "${ENV_FILE}" | head -1 | cut -d= -f2- || true)
    echo "${v:-${default}}"
}

POSTGRES_USER=$(read_env_var POSTGRES_USER oddzilla)
POSTGRES_DB=$(read_env_var POSTGRES_DB oddzilla)
BACKUP_GPG_RECIPIENT=$(read_env_var BACKUP_GPG_RECIPIENT)

if ! docker exec "${CONTAINER}" sh -c 'test -n "$POSTGRES_PASSWORD"'; then
    echo "pg_backup: POSTGRES_PASSWORD is not set inside ${CONTAINER}" >&2
    exit 1
fi

# pg_dump inside the container, password taken from the container's own
# env. user/db go in as positional args so no value is interpolated into
# the sh -c string.
pg_dump_in_container() {
    docker exec "${CONTAINER}" \
        sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump --host=127.0.0.1 --port=5432 --username="$1" --dbname="$2" --no-owner --clean --if-exists' \
        sh "${POSTGRES_USER}" "${POSTGRES_DB}"
}

DUMP="${BACKUP_DIR}/oddzilla-${TS}.sql.gz"
if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
    DUMP="${DUMP}.gpg"
fi
DUMP_TMP="${DUMP}.part"

# Keep only the newest $1 dumps; delete the rest. Count-based (not mtime)
# so the local footprint stays hard-bounded even if a run is skipped.
# Tolerates 0 or 1 existing dumps (tail of a short list is empty).
prune_dumps() {
    local keep="$1"
    if [ "${keep}" -lt 0 ]; then keep=0; fi
    find "${BACKUP_DIR}" -maxdepth 1 -type f \
         \( -name 'oddzilla-*.sql.gz' -o -name 'oddzilla-*.sql.gz.gpg' \) \
         -printf '%T@ %p\n' \
        | sort -rn \
        | tail -n +"$((keep + 1))" \
        | cut -d' ' -f2- \
        | xargs -r rm -f --
}

# Make room BEFORE dumping: drop all but the newest (RETENTION_COUNT-1)
# so a fresh ~4.5 GB dump has space. This is the lesson of 2026-06-09 —
# rotation that runs only AFTER the dump never executes when the dump
# itself fails on a full disk, so the pile-up never self-corrects. Also
# clear any leftover .part from a previously-failed run.
rm -f "${BACKUP_DIR}"/oddzilla-*.part 2>/dev/null || true
prune_dumps "$((RETENTION_COUNT - 1))"

# pg_dump runs inside the postgres container; gzip / gpg run on host.
# Write to a .part temp and atomically rename on success so a truncated
# dump (e.g. disk fills mid-write) can never masquerade as a valid backup.
if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
    pg_dump_in_container \
        | gzip -9 \
        | gpg --batch --yes --trust-model always \
              --encrypt --recipient "${BACKUP_GPG_RECIPIENT}" \
              --output "${DUMP_TMP}"
else
    pg_dump_in_container \
        | gzip -9 > "${DUMP_TMP}"
fi
mv -f "${DUMP_TMP}" "${DUMP}"

chown root:team "${DUMP}" 2>/dev/null || true
chmod 640 "${DUMP}"

# Final safety prune (no-op in the normal path; catches a lowered
# RETENTION_COUNT).
prune_dumps "${RETENTION_COUNT}"

# Emit a one-line JSON event to journal for grep-ability.
size=$(stat -c %s "${DUMP}")
encrypted=false
[ -n "${BACKUP_GPG_RECIPIENT}" ] && encrypted=true
printf '{"service":"pg-backup","event":"dump_complete","file":"%s","bytes":%d,"retention_count":%d,"encrypted":%s}\n' \
    "${DUMP}" "${size}" "${RETENTION_COUNT}" "${encrypted}"
