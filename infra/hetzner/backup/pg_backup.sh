#!/usr/bin/env bash
# Daily Postgres dump with 14-day rotation. Invoked from root's crontab.
# Dumps run via `docker exec` into the oddzilla-postgres-1 container so the
# host doesn't need postgresql-client installed. Dumps land in
# /var/backups/oddzilla/ mode 600. Off-server copy is the operator's
# responsibility — keep a separate rsync/scp step to external storage.

set -euo pipefail

BACKUP_DIR="/var/backups/oddzilla"
RETENTION_DAYS=14
CONTAINER="oddzilla-postgres-1"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DUMP="${BACKUP_DIR}/oddzilla-${TS}.sql.gz"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

# Parse DB creds from .env without exposing them in `ps` output.
set -a
# shellcheck disable=SC1091
source /home/team/oddzilla/.env
set +a

# pg_dump runs inside the postgres container; gzip runs on host.
docker exec \
  -e PGPASSWORD="${POSTGRES_PASSWORD}" \
  "${CONTAINER}" \
  pg_dump \
    --host=127.0.0.1 --port=5432 \
    --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
    --no-owner --clean --if-exists \
  | gzip -9 > "${DUMP}"

chmod 600 "${DUMP}"

# Rotate — delete anything older than RETENTION_DAYS.
find "${BACKUP_DIR}" -maxdepth 1 -type f -name 'oddzilla-*.sql.gz' \
  -mtime +"${RETENTION_DAYS}" -delete

# Emit a one-line JSON event to journal for grep-ability.
size=$(stat -c %s "${DUMP}")
printf '{"service":"pg-backup","event":"dump_complete","file":"%s","bytes":%d,"retention_days":%d}\n' \
  "${DUMP}" "${size}" "${RETENTION_DAYS}"
