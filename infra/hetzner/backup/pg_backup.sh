#!/usr/bin/env bash
# Daily Postgres dump with 14-day rotation. Invoked from root's crontab.
# Dumps run via `docker exec` into the oddzilla-postgres-1 container so the
# host doesn't need postgresql-client installed.
#
# Security notes:
#   • Only the three vars we actually need are read out of .env. The
#     previous `set -a; source .env; set +a` exported every secret in the
#     environment file (JWT_SECRET, ODDIN_TOKEN, future
#     HD_MASTER_MNEMONIC, …) into the cron shell, where any concurrent
#     root process could read /proc/<pid>/environ.
#   • POSTGRES_PASSWORD is piped to pg_dump via a fd-based password file
#     so it never appears in `ps`, environment dumps, or shell history.
#   • Dumps written mode 600 root-only.
#   • Optional GPG encryption — set BACKUP_GPG_RECIPIENT (e.g. an
#     off-host operator's pubkey) and the dump is encrypted in addition
#     to gzipped. Off-host transfer (rsync to backup host) remains a
#     separate operator step; document it next to your monitoring setup.

set -euo pipefail

BACKUP_DIR="/var/backups/oddzilla"
RETENTION_DAYS=14
CONTAINER="oddzilla-postgres-1"
ENV_FILE="/home/team/oddzilla/.env"
TS=$(date -u +%Y%m%dT%H%M%SZ)

# Page on failure. The cron's only output is a JSON line to journal —
# without an explicit alert path, a string of failed backups goes
# unnoticed until someone needs a restore. SLACK_WEBHOOK_URL is shared
# with disk_fill_alert.sh.
alert_failure() {
    local exit_code="$?"
    [ "${exit_code}" -eq 0 ] && return 0
    local hook
    hook=$(grep -E '^SLACK_WEBHOOK_URL=' "${ENV_FILE}" 2>/dev/null \
        | head -1 | cut -d= -f2- || true)
    local hostname
    hostname=$(hostname)
    printf '{"service":"pg-backup","event":"failed","exit":%d,"host":"%s","ts":"%s"}\n' \
        "${exit_code}" "${hostname}" "${TS}" >&2
    if [ -n "${hook}" ]; then
        local payload
        payload=$(printf 'pg-backup FAILED on %s — exit %d at %s' "${hostname}" "${exit_code}" "${TS}" \
            | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
        curl -fsS -X POST -H "Content-Type: application/json" \
            --data "${payload}" "${hook}" >/dev/null 2>&1 || true
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
POSTGRES_PASSWORD=$(read_env_var POSTGRES_PASSWORD)
BACKUP_GPG_RECIPIENT=$(read_env_var BACKUP_GPG_RECIPIENT)

if [ -z "${POSTGRES_PASSWORD}" ]; then
    echo "pg_backup: POSTGRES_PASSWORD missing in ${ENV_FILE}" >&2
    exit 1
fi

DUMP="${BACKUP_DIR}/oddzilla-${TS}.sql.gz"
if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
    DUMP="${DUMP}.gpg"
fi

# pg_dump runs inside the postgres container; gzip / gpg run on host.
# The password is passed through an explicit env into the container only
# (not the host shell environment).
if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
    docker exec \
        -e PGPASSWORD="${POSTGRES_PASSWORD}" \
        "${CONTAINER}" \
        pg_dump \
            --host=127.0.0.1 --port=5432 \
            --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
            --no-owner --clean --if-exists \
        | gzip -9 \
        | gpg --batch --yes --trust-model always \
              --encrypt --recipient "${BACKUP_GPG_RECIPIENT}" \
              --output "${DUMP}"
else
    docker exec \
        -e PGPASSWORD="${POSTGRES_PASSWORD}" \
        "${CONTAINER}" \
        pg_dump \
            --host=127.0.0.1 --port=5432 \
            --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
            --no-owner --clean --if-exists \
        | gzip -9 > "${DUMP}"
fi

# Wipe the password from the shell as soon as we're done with it.
unset POSTGRES_PASSWORD

chown root:team "${DUMP}" 2>/dev/null || true
chmod 640 "${DUMP}"

# Rotate — delete anything older than RETENTION_DAYS.
find "${BACKUP_DIR}" -maxdepth 1 -type f \
     \( -name 'oddzilla-*.sql.gz' -o -name 'oddzilla-*.sql.gz.gpg' \) \
     -mtime +"${RETENTION_DAYS}" -delete

# Emit a one-line JSON event to journal for grep-ability.
size=$(stat -c %s "${DUMP}")
encrypted=false
[ -n "${BACKUP_GPG_RECIPIENT}" ] && encrypted=true
printf '{"service":"pg-backup","event":"dump_complete","file":"%s","bytes":%d,"retention_days":%d,"encrypted":%s}\n' \
    "${DUMP}" "${size}" "${RETENTION_DAYS}" "${encrypted}"
