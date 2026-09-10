#!/usr/bin/env bash
# Assert that every service the compose file defines has a running
# container.
#
# This is the backstop for "the deploy finished and reported success,
# but a service isn't actually there". It exists because that happened
# twice: support-ai-bot (2026-09-01) and slotzilla (2026-09-10). In both
# cases the commit ADDED a compose service, the deploy's service
# detection could not see it (see the long note in deploy.sh), and the
# container was never created — while the rest of the commit, storefront
# included, went live. Nothing in the pipeline noticed: the build step
# built what it was told, the recreate step recreated what it was told,
# and smoke.sh only probes HTTP surfaces behind Caddy, so a Go worker
# with no public endpoint can be missing entirely and every check passes.
#
# The comparison is deliberately made against `compose config --services`
# rather than against the ${SERVICES} list the deploy computed. If that
# detection is ever wrong again, the missing service is BY DEFINITION
# absent from ${SERVICES} — so checking that list against itself would
# agree with the mistake and report success. The compose file is the
# only statement of what is supposed to be running that is independent
# of the bug being guarded against.
#
# Scope: presence, not health. A container that is running but failing
# its healthcheck is compose's business (and the operator's); this
# check answers the narrower question "does it exist and is it up",
# which is the one that was silently answered wrong.
#
# Exit codes:
#   0  every compose service has a running container
#   1  one or more are missing
#   2  could not enumerate (compose unavailable / config error)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# A brief settle window: `compose up -d` returns once containers are
# started, but a container that exits immediately (bad env, missing
# mount) can still be "started" for a moment. Re-checking for a few
# seconds turns that race into a real failure report rather than an
# intermittent pass.
VERIFY_TOTAL_TIMEOUT_S="${VERIFY_TOTAL_TIMEOUT_S:-30}"
VERIFY_RETRY_INTERVAL_S="${VERIFY_RETRY_INTERVAL_S:-3}"

expected="$("${COMPOSE[@]}" config --services 2>/dev/null | sort -u)"
if [ -z "${expected}" ]; then
  err "could not enumerate compose services"
  exit 2
fi

start_ts="${SECONDS}"
attempt=0
while :; do
  attempt=$((attempt + 1))

  # `|| true` so a transient docker hiccup produces an empty running set
  # (and therefore a retry) instead of aborting under `set -e`.
  running="$("${COMPOSE[@]}" ps --status running --format '{{.Service}}' 2>/dev/null | sort -u || true)"
  missing="$(comm -23 <(printf '%s\n' "${expected}") <(printf '%s\n' "${running}") || true)"

  if [ -z "${missing}" ]; then
    count="$(printf '%s\n' "${expected}" | wc -l | tr -d ' ')"
    if [ "${attempt}" -eq 1 ]; then
      log "OK   all ${count} compose services have a running container"
    else
      log "OK   all ${count} compose services running (after $((SECONDS - start_ts))s, attempt ${attempt})"
    fi
    exit 0
  fi

  if [ "$((SECONDS - start_ts))" -ge "${VERIFY_TOTAL_TIMEOUT_S}" ]; then
    err "compose services with no running container: $(printf '%s' "${missing}" | tr '\n' ' ')"
    err "the deploy is INCOMPLETE — those services are defined but absent"
    err "start one with: sudo -n docker compose up -d --no-deps <service>"
    err "if the service is new, it also needs an image tag + rollback entry:"
    err "  bash infra/deploy/tag-images.sh <sha> <service>"
    exit 1
  fi

  if [ "${attempt}" -eq 2 ]; then
    log "WAIT missing: $(printf '%s' "${missing}" | tr '\n' ' ') — retrying for up to ${VERIFY_TOTAL_TIMEOUT_S}s"
  fi
  sleep "${VERIFY_RETRY_INTERVAL_S}"
done
