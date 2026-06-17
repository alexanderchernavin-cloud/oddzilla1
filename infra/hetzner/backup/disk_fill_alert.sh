#!/usr/bin/env bash
# Disk-fill watchdog. Emails the operator when the root filesystem crosses
# DISK_FILL_THRESHOLD_PCT (default 80). Runs from root cron every 15 min —
# the disk filled to 100% during the 2026-04-22 -> 2026-04-28 incident,
# taking postgres down for 6 days before anyone noticed, and again on
# 2026-06-09 (crash-looped postgres for hours). docker_prune + the
# count-based pg-backup retention are passive mitigations; this is the
# active page that catches whatever still creeps up.
#
# Install:
#   sudo cp infra/hetzner/backup/alert_email.sh /usr/local/bin/oddzilla-alert-email
#   sudo chmod 755 /usr/local/bin/oddzilla-alert-email
#   sudo cp infra/hetzner/backup/disk_fill_alert.sh /usr/local/bin/oddzilla-disk-fill-alert
#   sudo chmod 750 /usr/local/bin/oddzilla-disk-fill-alert
#   sudo crontab -e
#   # Add: */15 * * * * /usr/local/bin/oddzilla-disk-fill-alert >> /var/log/oddzilla-disk-fill-alert.log 2>&1
#
# Paging goes through oddzilla-alert-email (Resend HTTP API). Without
# EMAIL_PROVIDER_TOKEN + ALERT_EMAIL_TO in /home/team/oddzilla/.env the
# helper logs a JSON line to journal and exits 0, so this watchdog still
# runs and records every check — it just can't page until email is wired.

set -euo pipefail

THRESHOLD="${DISK_FILL_THRESHOLD_PCT:-80}"
MOUNT="${DISK_FILL_MOUNT:-/}"
ALERT_CMD="${ALERT_CMD:-/usr/local/bin/oddzilla-alert-email}"

# df --output=pcent prints "Use%\n42%". Strip header + trailing %.
pct=$(df --output=pcent "${MOUNT}" | tail -n 1 | tr -d ' %')

if [ "${pct}" -lt "${THRESHOLD}" ]; then
    printf '{"service":"disk-fill-alert","event":"under_threshold","pct":%d,"threshold":%d,"mount":"%s"}\n' \
        "${pct}" "${THRESHOLD}" "${MOUNT}"
    exit 0
fi

avail=$(df -h --output=avail "${MOUNT}" | tail -n 1 | tr -d ' ')
hostname_s=$(hostname)

printf '{"service":"disk-fill-alert","event":"over_threshold","pct":%d,"threshold":%d,"mount":"%s","avail":"%s"}\n' \
    "${pct}" "${THRESHOLD}" "${MOUNT}" "${avail}"

# Top disk consumers help triage straight from the email.
top_dirs=$(du -xh --max-depth=1 / 2>/dev/null | sort -rh | head -6 | tr '\n' ';' || true)

subject="disk ${pct}% (mount ${MOUNT})"
body="Root filesystem at ${pct}% on ${hostname_s} (mount ${MOUNT}, avail ${avail}), threshold ${THRESHOLD}%.

Largest under /: ${top_dirs}

Recovery recipe: prune docker build cache (sudo docker builder prune -af), vacuum journald (sudo journalctl --vacuum-size=200M), trim /var/backups/oddzilla, then restart postgres if it is crash-looping."

# Best-effort: a failed page must not crash the watchdog (the next run
# retries). The helper itself is graceful-idle when email is unconfigured.
"${ALERT_CMD}" "${subject}" "${body}" || \
    printf '{"service":"disk-fill-alert","event":"page_failed","pct":%d}\n' "${pct}"
