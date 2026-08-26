#!/usr/bin/env bash
# Nightly odds_history partition maintenance. Since the 2026-08-26
# partition-swap the table runs on DAILY dated partitions
# (odds_history_pYYYYMMDD, UTC-midnight bounds) plus a safety DEFAULT
# (odds_history_default3) for stray timestamps. This script:
#
#   1. creates dated partitions ahead (today .. today+CREATE_AHEAD) so
#      inserts never fall through to the DEFAULT;
#   2. drops dated partitions older than RETENTION_DAYS — a partition
#      DROP is instant and returns space to the OS immediately, so the
#      table carries ZERO bloat and no high-water mark, ever (the
#      pre-2026-08-26 model was a batched DELETE that plateaued the
#      heap at ~60 GB without shrinking it);
#   3. sweeps the safety DEFAULT with a small batched DELETE — it
#      should stay empty (recovery replays reach back <= 24 h and land
#      in dated partitions), so a non-trivial row count there is logged
#      as a warning worth investigating.
#
# History
#   odds_history was declared PARTITION BY RANGE (ts) from migration
#   0000 but ran on a single catch-all DEFAULT partition until
#   2026-07-02 (first reclaim: 95% -> 50% disk) and then again until
#   2026-08-26 (second reclaim: export -> drop -> restore into dated
#   partitions, window 45 -> 35 days; see docs/OPERATIONS.md).
#
# Install
#   sudo cp infra/hetzner/backup/odds_retention.sh /usr/local/bin/oddzilla-odds-retention
#   sudo chmod 750 /usr/local/bin/oddzilla-odds-retention
#   sudo crontab -e
#   # 30 3 * * * /usr/local/bin/oddzilla-odds-retention >> /var/log/oddzilla-odds-retention.log 2>&1
#
# Tunables (env overrides):
#   ODDS_RETENTION_DAYS   days of history to keep      (default 35; admin
#                         odds charts look back 30, ZillaTips reads the
#                         permanent prematch_odds snapshot, settlement
#                         never reads history)
#   ODDS_CREATE_AHEAD     days of partitions pre-created (default 7 — a
#                         week of missed cron runs before inserts start
#                         landing in the DEFAULT, which is safe anyway)
#   ODDS_RETENTION_BATCH  rows per DELETE on the DEFAULT sweep (default 100000)

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"
CONTAINER="${ODDS_RETENTION_CONTAINER:-oddzilla-postgres-1}"
RETENTION_DAYS="${ODDS_RETENTION_DAYS:-35}"
CREATE_AHEAD="${ODDS_CREATE_AHEAD:-7}"
BATCH="${ODDS_RETENTION_BATCH:-100000}"
ALERT_CMD="${ALERT_CMD:-/usr/local/bin/oddzilla-alert-email}"

alert_failure() {
    local rc="$?"
    [ "${rc}" -eq 0 ] && return 0
    printf '{"service":"odds-retention","event":"failed","exit":%d}\n' "${rc}" >&2
    if [ -x "${ALERT_CMD}" ]; then
        "${ALERT_CMD}" "odds-retention FAILED (exit ${rc})" \
            "Nightly odds_history partition maintenance failed on $(hostname) with exit ${rc}. See /var/log/oddzilla-odds-retention.log." \
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

printf '{"service":"odds-retention","event":"start","retention_days":%d,"create_ahead":%d}\n' \
    "${RETENTION_DAYS}" "${CREATE_AHEAD}"

# ── 1. Create partitions ahead ──────────────────────────────────────────
# IF NOT EXISTS makes re-runs (and overlap with days the swap already
# created) a no-op. Bounds are UTC midnights, matching the swap.
created=0
i=0
while [ "${i}" -le "${CREATE_AHEAD}" ]; do
    d=$(date -u -d "+${i} days" +%F)
    next=$(date -u -d "+$((i + 1)) days" +%F)
    pname="odds_history_p$(date -u -d "${d}" +%Y%m%d)"
    out=$(psql_q "CREATE TABLE IF NOT EXISTS ${pname} PARTITION OF odds_history FOR VALUES FROM ('${d}') TO ('${next}');" 2>&1) || {
        echo "odds-retention: create ${pname} failed: ${out}" >&2
        exit 1
    }
    created=$((created + 1))
    i=$((i + 1))
done

# ── 2. Drop dated partitions past the window ────────────────────────────
# DETACH CONCURRENTLY first so the parent lock stays share-level (feed
# inserts don't stall), then DROP the standalone table (instant, returns
# space to the OS).
cutoff=$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%d)
old_parts=$(psql_q "SELECT c.relname
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
 WHERE i.inhparent = 'odds_history'::regclass
   AND c.relname ~ '^odds_history_p[0-9]{8}\$'
   AND substring(c.relname from 16) < '${cutoff}'
 ORDER BY c.relname;")
dropped=0
for p in ${old_parts}; do
    psql_q "ALTER TABLE odds_history DETACH PARTITION ${p} CONCURRENTLY;" >/dev/null
    psql_q "DROP TABLE ${p};" >/dev/null
    printf '{"service":"odds-retention","event":"partition_dropped","partition":"%s"}\n' "${p}"
    dropped=$((dropped + 1))
done

# ── 3. Safety-DEFAULT sweep ─────────────────────────────────────────────
# odds_history_default3 should be empty; anything landing there has a
# timestamp outside every dated partition (clock skew, replay older than
# the create-ahead window). Trim rows past the retention window in small
# batches and surface the count.
default_deleted=0
while :; do
    n=$(psql_q "WITH del AS (
            DELETE FROM odds_history_default3
            WHERE ctid IN (
                SELECT ctid FROM odds_history_default3
                WHERE ts < now() - interval '${RETENTION_DAYS} days'
                LIMIT ${BATCH}
            )
            RETURNING 1
        ) SELECT count(*) FROM del;" | tr -d '[:space:]')
    n=${n:-0}
    default_deleted=$((default_deleted + n))
    [ "${n}" -lt "${BATCH}" ] && break
    sleep 2
done
default_rows=$(psql_q "SELECT count(*) FROM odds_history_default3;" | tr -d '[:space:]')
if [ "${default_rows:-0}" -gt 10000 ]; then
    printf '{"service":"odds-retention","event":"default_not_empty","rows":%s}\n' "${default_rows}" >&2
fi

unset PGPASSWORD

printf '{"service":"odds-retention","event":"complete","partitions_ensured":%d,"partitions_dropped":%d,"default_deleted":%d,"default_rows":%s}\n' \
    "${created}" "${dropped}" "${default_deleted}" "${default_rows:-0}"
