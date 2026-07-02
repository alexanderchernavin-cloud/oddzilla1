#!/usr/bin/env bash
# Send an ops alert email via the Resend HTTP API. Self-contained so the
# cron scripts (disk-fill watchdog, pg-backup failure trap) can page the
# operator WITHOUT the app stack being healthy — the whole point of an
# alert is that it fires when something is already broken.
#
# Resend is the same provider the app standardises on (EMAIL_PROVIDER=resend),
# so this reuses EMAIL_PROVIDER_TOKEN + EMAIL_FROM straight out of .env.
#
# Graceful-idle: if EMAIL_PROVIDER_TOKEN or the recipient is unset it logs
# a single JSON line to journal and exits 0 — matching the app's dormant-
# email pattern, so callers never have to special-case the unconfigured
# state. Activate real paging by setting EMAIL_PROVIDER_TOKEN (Resend key)
# and ALERT_EMAIL_TO in /home/team/oddzilla/.env.
#
# Install:
#   sudo cp infra/hetzner/backup/alert_email.sh /usr/local/bin/oddzilla-alert-email
#   sudo chmod 755 /usr/local/bin/oddzilla-alert-email
#
# Usage: oddzilla-alert-email "subject" "body text"

set -euo pipefail

ENV_FILE="${ENV_FILE:-/home/team/oddzilla/.env}"

read_env_var() {
    local key="$1"
    local default="${2:-}"
    local v
    v=$(grep -E "^${key}=" "${ENV_FILE}" 2>/dev/null | head -1 | cut -d= -f2- || true)
    echo "${v:-${default}}"
}

SUBJECT="${1:-Oddzilla alert}"
BODY="${2:-}"
HOSTNAME_S=$(hostname)

TOKEN=$(read_env_var EMAIL_PROVIDER_TOKEN)
FROM=$(read_env_var EMAIL_FROM noreply@oddzilla.cc)
TO=$(read_env_var ALERT_EMAIL_TO)
# Fall back to the app's reply-to if a dedicated alert recipient isn't set.
if [ -z "${TO}" ]; then TO=$(read_env_var EMAIL_REPLY_TO); fi

if [ -z "${TOKEN}" ] || [ -z "${TO}" ]; then
    printf '{"service":"alert-email","event":"skipped","reason":"missing_token_or_recipient","subject":"%s"}\n' \
        "${SUBJECT}"
    exit 0
fi

# Build the JSON body in python3 so subject/body are escaped correctly
# regardless of quotes/newlines. Values pass through the environment, not
# argv, so they never land in `ps`.
payload=$(OZ_SUBJECT="[Oddzilla ${HOSTNAME_S}] ${SUBJECT}" OZ_BODY="${BODY}" \
          OZ_FROM="${FROM}" OZ_TO="${TO}" python3 -c '
import json, os
print(json.dumps({
    "from": os.environ["OZ_FROM"],
    "to": [os.environ["OZ_TO"]],
    "subject": os.environ["OZ_SUBJECT"],
    "text": os.environ["OZ_BODY"],
}))')

# -fsS: silent on success, non-zero exit on HTTP/transport failure so the
# caller (or the next cron run) knows the page didn't go out.
curl -fsS -X POST "https://api.resend.com/emails" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}" >/dev/null

printf '{"service":"alert-email","event":"sent","subject":"%s","to":"%s"}\n' \
    "${SUBJECT}" "${TO}"
