#!/usr/bin/env bash
# Daily audit-log tamper-evidence check. Runs admin_audit_chain_check()
# (migration 0026) and pages via Slack if ANY row's hash no longer matches
# — i.e. a row in admin_audit_log was edited via direct DB access after
# insert. Without this the SHA-256 chain is dormant: verifiable, but only
# when a human remembers to SSH in and run it (audit finding SEC-L: the
# verifier exists but nothing runs it automatically).
#
# Install:
#   sudo cp infra/hetzner/backup/audit_chain_check.sh /usr/local/bin/oddzilla-audit-chain-check
#   sudo chmod 750 /usr/local/bin/oddzilla-audit-chain-check
#   sudo crontab -e
#   # Add (daily 04:00 UTC, just after the 03:00 pg backup):
#   0 4 * * * /usr/local/bin/oddzilla-audit-chain-check
#
# Security notes (mirrors pg_backup.sh):
#   • Only the vars we need are read out of .env — never `source .env`,
#     which would export every secret into the cron shell.
#   • POSTGRES_PASSWORD is passed to psql via the container env only, then
#     unset; it never lands in `ps` or the host environment.
#   • SLACK_WEBHOOK_URL is shared with the other alert scripts. Without it
#     the script still logs a JSON line and (on tamper / failure) exits
#     non-zero so cron's MAILTO surfaces it.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"
CONTAINER="${PG_CONTAINER:-oddzilla-postgres-1}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
HOST=$(hostname)

read_env_var() {
    local key="$1"
    local default="${2:-}"
    local v
    v=$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    echo "${v:-${default}}"
}

POSTGRES_USER=$(read_env_var POSTGRES_USER oddzilla)
POSTGRES_DB=$(read_env_var POSTGRES_DB oddzilla)
POSTGRES_PASSWORD=$(read_env_var POSTGRES_PASSWORD)
WEBHOOK=$(read_env_var SLACK_WEBHOOK_URL)

alert() {
    local text="$1"
    printf '{"service":"audit-chain-check","event":"alert","host":"%s","ts":"%s","msg":"%s"}\n' \
        "${HOST}" "${TS}" "${text}" >&2
    [ -z "${WEBHOOK}" ] && return 0
    local payload
    payload=$(printf '%s' "${text}" \
        | python3 -c 'import json,sys; print(json.dumps({"text": sys.stdin.read()}))')
    curl -fsS -X POST -H "Content-Type: application/json" \
        --data "${payload}" "${WEBHOOK}" >/dev/null 2>&1 || true
}

if [ -z "${POSTGRES_PASSWORD}" ]; then
    alert "audit-chain-check could not run on ${HOST}: POSTGRES_PASSWORD missing in ${ENV_FILE}"
    exit 1
fi

# -tAc: tuples-only, unaligned (| separator), single command. Returns
# "valid|broken|total" for the whole admin_audit_log chain.
row=$(docker exec -e PGPASSWORD="${POSTGRES_PASSWORD}" "${CONTAINER}" \
    psql -tAc "SELECT count(*) FILTER (WHERE ok), count(*) FILTER (WHERE NOT ok), count(*) FROM admin_audit_chain_check();" \
    --host=127.0.0.1 --port=5432 --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}") || {
    alert "audit-chain-check FAILED to query on ${HOST} — verifier errored (function missing? db down?)"
    exit 1
}
unset POSTGRES_PASSWORD

valid="${row%%|*}"
rest="${row#*|}"
broken="${rest%%|*}"
total="${rest##*|}"

if [ "${broken:-0}" -ne 0 ]; then
    alert "AUDIT LOG TAMPER DETECTED on ${HOST}: ${broken} of ${total} admin_audit_log rows fail the SHA-256 hash chain. Someone edited the audit log via direct DB access. Investigate immediately."
    printf '{"service":"audit-chain-check","event":"tamper","valid":%s,"broken":%s,"total":%s,"host":"%s","ts":"%s"}\n' \
        "${valid}" "${broken}" "${total}" "${HOST}" "${TS}" >&2
    exit 2
fi

printf '{"service":"audit-chain-check","event":"ok","valid":%s,"broken":%s,"total":%s,"host":"%s","ts":"%s"}\n' \
    "${valid}" "${broken}" "${total}" "${HOST}" "${TS}"
