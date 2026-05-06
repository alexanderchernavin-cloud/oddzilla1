#!/usr/bin/env bash
# Disk-fill watchdog. Posts to a Slack webhook when the root filesystem
# crosses DISK_FILL_THRESHOLD_PCT (default 80). Runs from root cron at
# a tight interval (every 15 minutes) — the disk filled to 100% during
# the 2026-04-22 → 2026-04-28 incident, taking postgres down for 6 days
# before anyone noticed (project_disk_full_incident memory). docker_prune
# alone is a passive mitigation; this is the active page.
#
# Install:
#   sudo cp infra/hetzner/backup/disk_fill_alert.sh /usr/local/bin/oddzilla-disk-fill-alert
#   sudo chmod 750 /usr/local/bin/oddzilla-disk-fill-alert
#   sudo crontab -e
#   # Add: */15 * * * * /usr/local/bin/oddzilla-disk-fill-alert
#
# Set SLACK_WEBHOOK_URL in /home/team/oddzilla/.env (mode 600). Without
# the var the script logs a single JSON line to journal and exits 0 —
# operator can wire up email or another channel later without redeploying
# the script.

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"
THRESHOLD="${DISK_FILL_THRESHOLD_PCT:-80}"
MOUNT="${DISK_FILL_MOUNT:-/}"

read_env_var() {
    local key="$1"
    local default="${2:-}"
    local v
    v=$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    echo "${v:-${default}}"
}

webhook=$(read_env_var SLACK_WEBHOOK_URL)

# df --output=pcent prints "Use%\n42%". Strip header + trailing %.
pct=$(df --output=pcent "${MOUNT}" | tail -n 1 | tr -d ' %')

if [ "${pct}" -lt "${THRESHOLD}" ]; then
    printf '{"service":"disk-fill-alert","event":"under_threshold","pct":%d,"threshold":%d,"mount":"%s"}\n' \
        "${pct}" "${THRESHOLD}" "${MOUNT}"
    exit 0
fi

avail=$(df -h --output=avail "${MOUNT}" | tail -n 1 | tr -d ' ')
hostname=$(hostname)
text="Oddzilla disk fill: ${pct}% on ${hostname} (mount ${MOUNT}, avail ${avail}); threshold ${THRESHOLD}%."

printf '{"service":"disk-fill-alert","event":"over_threshold","pct":%d,"threshold":%d,"mount":"%s","avail":"%s"}\n' \
    "${pct}" "${THRESHOLD}" "${MOUNT}" "${avail}"

if [ -z "${webhook}" ]; then
    printf '{"service":"disk-fill-alert","event":"webhook_missing","note":"set SLACK_WEBHOOK_URL in .env to receive pages"}\n'
    exit 0
fi

# Embed the message in JSON, escaping the few characters Slack cares about.
payload=$(printf '%s' "${text}" \
    | python3 -c 'import json, sys; print(json.dumps({"text": sys.stdin.read()}))')

# -fsS: silent, but fail loudly with non-zero exit if the webhook is
# unreachable so the next cron run still tries (no quiet drop).
curl -fsS -X POST -H "Content-Type: application/json" \
    --data "${payload}" \
    "${webhook}" >/dev/null
