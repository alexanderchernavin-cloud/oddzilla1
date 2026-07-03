#!/usr/bin/env bash
# Nightly settlements retention. Deletes settle/cancel rows older than
# RETENTION_DAYS in bounded batches, mirroring odds_retention.sh (each
# statement is its own transaction so WAL recycles at the next checkpoint
# and row locks are held briefly).
#
# Why this exists
#   settlements is the apply-once log for Oddin settlement messages
#   (CLAUDE.md invariant #3). By 2026-07-02 it was 9.8 GB / 12.05M rows,
#   growing ~90-110 MB/day with no retention — the largest unbounded table
#   after odds_history was capped. Operator decision 2026-07-03: 45 days,
#   same window as odds_history. The durable record of what every bettor
#   won and why does NOT live here — tickets / ticket_selections /
#   wallet_ledger / market_outcomes.result are never deleted by anything.
#   This table is only the raw Oddin message journal on top of that.
#
# Why deleting apply-once dedup rows is safe after RETENTION_DAYS
#   The unique key only rejects BYTE-IDENTICAL replays (payload_hash is
#   part of the key — a genuine late re-settlement from Oddin carries a
#   different payload and is SUPPOSED to apply). Identical replays have
#   exactly two systematic sources, both bounded to ~1 day:
#     - AMQP redelivery of an unacked message (seconds..minutes);
#     - feed recovery replay, clamped to now-24h by RecoveryWindowCap in
#       services/feed-ingester/internal/handler/handler.go (snapshot
#       recovery carries odds state, not settlement messages).
#   And even if an identical settle/cancel somehow re-applied months
#   later, the money paths are independently idempotent:
#     - maybeSettleTicket skips every ticket not in status='accepted', and
#       the DELETE below additionally keeps rows whose market still has an
#       open (pending_delay/accepted) ticket — e.g. a combo with one leg
#       settled and another on a far-future match;
#     - market status -3/-4 is sticky and outcome-result rewrites are
#       idempotent (same values);
#     - wallet_ledger's unique (type, ref_type, ref_id) index blocks any
#       residual double-credit (invariant #4).
#   rollback_settle / rollback_cancel rows are NEVER deleted: a re-applied
#   rollback would reverse a settled ticket (claw back a real payout), and
#   at ~300 rows total keeping them forever is free.
#   A match-status gate (closed/cancelled) was considered and dropped: ~10%
#   of settlement rows reference matches wedged at not_started, which would
#   pin those rows forever, and the safety argument above never rests on
#   match status. Neither recovery flush path deletes markets (both are
#   SUSPEND-only), so pruning settlements rows cannot orphan or expose the
#   markets/outcomes they referenced.
#
# What it does / does not do
#   • Caps the table at ~45 days ≈ 5 GB at 2026-07 volume (~111 MB/day).
#     The first run deletes the ~6M-row backlog older than 45 days in one
#     night (batched); after that it's ~135K rows/night. Paired with the
#     per-table autovacuum reloptions set at install time (below), freed
#     space returns to the free-space map and is reused by new inserts,
#     so the heap PLATEAUS.
#   • It does NOT shrink the heap on disk — same caveat as odds_retention:
#     the ~10 GB high-water mark persists (half of it free space for
#     reuse) until a one-time reclaim, which this table does not justify.
#
# Install
#   sudo cp infra/hetzner/backup/settlements_retention.sh /usr/local/bin/oddzilla-settlements-retention
#   sudo chmod 750 /usr/local/bin/oddzilla-settlements-retention
#   # one-time: keep autovacuum ahead of the nightly delete churn
#   # (~135K dead tuples/day; default scale-factor 0.2 would wait ~2.4M).
#   set -a; . /home/team/oddzilla/.env; set +a
#   docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
#     "ALTER TABLE settlements SET (autovacuum_vacuum_scale_factor=0, autovacuum_vacuum_threshold=300000, autovacuum_vacuum_insert_scale_factor=0, autovacuum_vacuum_insert_threshold=2000000);"
#   sudo crontab -e
#   # Add (after the 03:00 pg-backup and the 03:30 odds-retention):
#   # 45 3 * * * /usr/local/bin/oddzilla-settlements-retention >> /var/log/oddzilla-settlements-retention.log 2>&1
#
# Tunables (env overrides):
#   SETTLEMENTS_RETENTION_DAYS  days settle/cancel rows live (default 45 — matches odds_history; the systematic replay window is only 24h)
#   SETTLEMENTS_RETENTION_BATCH rows per statement           (default 100000; settlements rows are fat (~860 B) and carry 4 indexes — smaller than odds_retention's 1M)

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"
CONTAINER="${SETTLEMENTS_RETENTION_CONTAINER:-oddzilla-postgres-1}"
RETENTION_DAYS="${SETTLEMENTS_RETENTION_DAYS:-45}"
BATCH="${SETTLEMENTS_RETENTION_BATCH:-100000}"
ALERT_CMD="${ALERT_CMD:-/usr/local/bin/oddzilla-alert-email}"

# Page the operator on any failure (container down, auth failure, runaway
# delete). Best-effort: a failed page must not mask the original error.
alert_failure() {
    local rc="$?"
    [ "${rc}" -eq 0 ] && return 0
    printf '{"service":"settlements-retention","event":"failed","exit":%d}\n' "${rc}" >&2
    if [ -x "${ALERT_CMD}" ]; then
        "${ALERT_CMD}" "settlements-retention FAILED (exit ${rc})" \
            "Nightly settlements retention failed on $(hostname) with exit ${rc}. See /var/log/oddzilla-settlements-retention.log." \
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
    echo "settlements-retention: POSTGRES_PASSWORD missing in ${ENV_FILE}" >&2
    exit 1
fi

# Password goes into the container's env only, never the host shell's argv.
psql_q() {
    docker exec -e PGPASSWORD="${PGPASSWORD}" "${CONTAINER}" \
        psql -U "${PGUSER}" -d "${PGDB}" -X -A -t -q -c "$1"
}

# Guards, per the header analysis:
#   • type IN ('settle','cancel') — rollback rows are kept forever;
#   • the market must have no open (pending_delay/accepted) ticket. The
#     open-ticket set is tiny (open slips only), so the CTE hashes cheaply
#     per statement.
eligible=$(psql_q "WITH open_m AS (
        SELECT DISTINCT ts.market_id
          FROM tickets t
          JOIN ticket_selections ts ON ts.ticket_id = t.id
         WHERE t.status IN ('pending_delay','accepted')
    )
    SELECT count(*) FROM settlements s
     WHERE s.processed_at < now() - interval '${RETENTION_DAYS} days'
       AND s.type IN ('settle','cancel')
       AND NOT EXISTS (SELECT 1 FROM open_m om WHERE om.market_id = s.market_id);" | tr -d '[:space:]')
printf '{"service":"settlements-retention","event":"start","retention_days":%d,"batch":%d,"eligible_rows":%s}\n' \
    "${RETENTION_DAYS}" "${BATCH}" "${eligible:-0}"

deleted_total=0
while :; do
    n=$(psql_q "WITH open_m AS (
            SELECT DISTINCT ts.market_id
              FROM tickets t
              JOIN ticket_selections ts ON ts.ticket_id = t.id
             WHERE t.status IN ('pending_delay','accepted')
        ), del AS (
            DELETE FROM settlements
            WHERE ctid IN (
                SELECT s.ctid FROM settlements s
                WHERE s.processed_at < now() - interval '${RETENTION_DAYS} days'
                  AND s.type IN ('settle','cancel')
                  AND NOT EXISTS (SELECT 1 FROM open_m om WHERE om.market_id = s.market_id)
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

printf '{"service":"settlements-retention","event":"complete","deleted":%d,"retention_days":%d}\n' \
    "${deleted_total}" "${RETENTION_DAYS}"
