#!/usr/bin/env bash
# Nightly odds_history retention. Deletes rows older than RETENTION_DAYS in
# bounded batches so a single run can't spike WAL on a disk that is already
# tight. Runs from root's crontab after the daily pg-backup.
#
# Why this exists
#   odds_history is declared PARTITION BY RANGE (ts) (migrations 0000 +
#   0001), but the partitioning was supposed to be driven by pg_partman OR
#   by a "Phase 3" partition-maintenance cron. pg_partman was never
#   installed in the postgres image and that cron was never built, so every
#   row since launch (2026-04-18) fell into the catch-all odds_history_default
#   partition. By 2026-06-17 it was 64 GB / 560M rows, growing ~1 GB/day,
#   and nothing ever pruned it. The disk filled to 100% and crash-looped
#   postgres on 2026-04-22, 2026-05-09, 2026-06-09 and 2026-06-17.
#
# What it does / does not do
#   • Caps the table at RETENTION_DAYS of history. Paired with the aggressive
#     per-table autovacuum set at install time (below), the space freed by
#     each night's delete is returned to the table's free-space map and
#     reused by new inserts, so the heap PLATEAUS instead of growing without
#     bound.
#   • It does NOT shrink the heap on disk — a plain DELETE never returns
#     pages to the OS. To actually reclaim the existing backlog, do the
#     one-time partition swap documented in docs/OPERATIONS.md ("odds_history
#     reclaim"). This script's job is to stop the bleeding, not to reclaim.
#
# Install
#   sudo cp infra/hetzner/backup/odds_retention.sh /usr/local/bin/oddzilla-odds-retention
#   sudo chmod 750 /usr/local/bin/oddzilla-odds-retention
#   # one-time: make autovacuum keep up with the nightly deletes so freed
#   # space is reused (default autovacuum would not trigger for ~12 days on
#   # a table this large, letting dead tuples — and the heap — accumulate).
#   set -a; . /home/team/oddzilla/.env; set +a
#   docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
#     "ALTER TABLE odds_history_default SET (autovacuum_vacuum_scale_factor=0, autovacuum_vacuum_threshold=2000000, autovacuum_vacuum_insert_scale_factor=0, autovacuum_vacuum_insert_threshold=2000000);"
#   sudo crontab -e
#   # Add (after the 03:00 pg-backup so the dump captures pre-deletion state):
#   # 30 3 * * * /usr/local/bin/oddzilla-odds-retention >> /var/log/oddzilla-odds-retention.log 2>&1
#
# Tunables (env overrides):
#   ODDS_RETENTION_DAYS   days of history to keep         (default 45; was 60 until 2026-07-02 — daily odds volume grew ~17.5M rows/day and the 60-day window pushed dumps past 8 GB)
#   ODDS_RETENTION_BATCH  rows deleted per statement      (default 1000000)

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"
CONTAINER="${ODDS_RETENTION_CONTAINER:-oddzilla-postgres-1}"
RETENTION_DAYS="${ODDS_RETENTION_DAYS:-45}"
BATCH="${ODDS_RETENTION_BATCH:-1000000}"
ALERT_CMD="${ALERT_CMD:-/usr/local/bin/oddzilla-alert-email}"
TABLE="odds_history"

# Page the operator on any failure (container down, auth failure, runaway
# delete). Best-effort: a failed page must not mask the original error.
alert_failure() {
    local rc="$?"
    [ "${rc}" -eq 0 ] && return 0
    printf '{"service":"odds-retention","event":"failed","exit":%d}\n' "${rc}" >&2
    if [ -x "${ALERT_CMD}" ]; then
        "${ALERT_CMD}" "odds-retention FAILED (exit ${rc})" \
            "Nightly odds_history retention failed on $(hostname) with exit ${rc}. See /var/log/oddzilla-odds-retention.log." \
            || true
    fi
}
trap alert_failure EXIT

# Read only the postgres credentials we need — never `source` the whole .env
# (that would export every secret into this cron shell's environment).
read_env_var() {
    local key="$1" default="${2:-}" v
    v=$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    echo "${v:-${default}}"
}

PGUSER=$(read_env_var POSTGRES_USER oddzilla)
PGDB=$(read_env_var POSTGRES_DB oddzilla)
PGPASSWORD=$(read_env_var POSTGRES_PASSWORD)
if [ -z "${PGPASSWORD}" ]; then
    echo "odds-retention: POSTGRES_PASSWORD missing in ${ENV_FILE}" >&2
    exit 1
fi

# Password goes into the container's env only, never the host shell's argv.
psql_q() {
    docker exec -e PGPASSWORD="${PGPASSWORD}" "${CONTAINER}" \
        psql -U "${PGUSER}" -d "${PGDB}" -X -A -t -q -c "$1"
}

eligible=$(psql_q "SELECT count(*) FROM ${TABLE} WHERE ts < now() - interval '${RETENTION_DAYS} days';" | tr -d '[:space:]')
printf '{"service":"odds-retention","event":"start","retention_days":%d,"batch":%d,"eligible_rows":%s}\n' \
    "${RETENTION_DAYS}" "${BATCH}" "${eligible:-0}"

# Batched delete: each statement is its own transaction, so WAL is recycled
# at the next checkpoint and row locks are held only briefly — a single
# giant DELETE on a catch-up (missed-cron) night could otherwise spike WAL
# and re-fill the very disk we are protecting. The LIMIT subquery stops
# scanning as soon as it has collected a batch of eligible (oldest, heap-
# front) rows, so it does not seq-scan the whole table.
deleted_total=0
while :; do
    n=$(psql_q "WITH del AS (
            DELETE FROM ${TABLE}
            WHERE ctid IN (
                SELECT ctid FROM ${TABLE}
                WHERE ts < now() - interval '${RETENTION_DAYS} days'
                LIMIT ${BATCH}
            )
            RETURNING 1
        ) SELECT count(*) FROM del;" | tr -d '[:space:]')
    n=${n:-0}
    deleted_total=$((deleted_total + n))
    [ "${n}" -lt "${BATCH}" ] && break
    sleep 2
done

unset PGPASSWORD

printf '{"service":"odds-retention","event":"complete","deleted":%d,"retention_days":%d}\n' \
    "${deleted_total}" "${RETENTION_DAYS}"
