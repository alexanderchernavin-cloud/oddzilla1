#!/usr/bin/env bash
# Post-deploy smoke check. Run after containers are healthy to catch
# the class of bugs that pass healthcheck but break user-facing
# functionality (e.g. a Caddy config change that returns 404 for /api/*
# while api itself stays up).
#
# Each endpoint maps to one service surface; collectively they cover
# Caddy + web SSR + api REST. WebSocket is not yet probed — the
# ws-gateway has its own /healthz inside the container which compose
# already checks. A real client-handshake probe would need a small Go
# tool, deferred until we see WS bugs slip past container health.
#
# Retry window: each check is retried for up to SMOKE_TOTAL_TIMEOUT_S
# (default 60 s) at SMOKE_RETRY_INTERVAL_S intervals (default 3 s).
# This exists because docker-compose's "healthy" state for `api` only
# guarantees the container's own /healthz probe passes — Caddy's
# upstream view of the new container takes another ~10–20 s to
# stabilise after a `--force-recreate` (the previous IP is cached for
# the duration of the previous keepalive pool, the new container
# resolves on next refresh). Without the retry, every recreate-deploy
# produced 502 false-positives on the api endpoints even when the
# rollout was clean, which trained operators to ignore the failure
# line — exactly the opposite of what a smoke check is for. A real
# failure (Caddy config broken, api crash loop) still trips: it just
# takes ~SMOKE_TOTAL_TIMEOUT_S to surface instead of <1 s.
#
# Exit codes:
#   0  all green
#   1  one or more checks failed (after retries)
#   2  bad invocation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

# Tunables — override via env in deploy.sh / rollback.sh if a slower
# box needs a wider window.
SMOKE_TOTAL_TIMEOUT_S="${SMOKE_TOTAL_TIMEOUT_S:-60}"
SMOKE_RETRY_INTERVAL_S="${SMOKE_RETRY_INTERVAL_S:-3}"
SMOKE_PER_HIT_TIMEOUT_S="${SMOKE_PER_HIT_TIMEOUT_S:-10}"

# Each entry: <expected-status>:<path>:<label>
# Auth/me is hit anonymously, so 401 is the healthy response — getting
# 200 there means we leaked sessions, getting 500 means the auth
# plugin choked at startup.
CHECKS=(
  "200:/healthz:web SSR /healthz"
  "200:/:web SSR /"
  "200:/api/healthz:api /healthz via Caddy"
  "200:/api/catalog/sports:api /catalog/sports via Caddy"
  "401:/api/auth/me:api /auth/me anonymous"
)

# Attempt a single endpoint with retry. Returns 0 on eventual success,
# 1 on timeout. Logs OK / WAIT / FAIL with attempt count so the
# operator can see whether a deploy was actually healthy from the
# first probe or only after warm-up.
attempt_check() {
  local expected="$1" url="$2" label="$3"
  local start_ts attempt actual
  start_ts="${SECONDS}"
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${SMOKE_PER_HIT_TIMEOUT_S}" "${url}" || echo 000)"
    if [ "${actual}" = "${expected}" ]; then
      if [ "${attempt}" -eq 1 ]; then
        log "OK   ${actual} ${label}"
      else
        log "OK   ${actual} ${label} (after $((SECONDS - start_ts))s, attempt ${attempt})"
      fi
      return 0
    fi
    if [ "$((SECONDS - start_ts))" -ge "${SMOKE_TOTAL_TIMEOUT_S}" ]; then
      err "FAIL ${actual} (want ${expected}, after $((SECONDS - start_ts))s / ${attempt} attempts) ${label} — ${url}"
      return 1
    fi
    # Only log WAIT once per stretch so a slow warm-up doesn't drown
    # the log in repeating lines — attempt 2 is the signal that
    # something is taking time; attempts 3..N are just noise.
    if [ "${attempt}" -eq 2 ]; then
      log "WAIT ${actual} (want ${expected}) ${label} — retrying for up to ${SMOKE_TOTAL_TIMEOUT_S}s"
    fi
    sleep "${SMOKE_RETRY_INTERVAL_S}"
  done
}

fail=0
for entry in "${CHECKS[@]}"; do
  expected="${entry%%:*}"
  rest="${entry#*:}"
  path="${rest%%:*}"
  label="${rest#*:}"
  url="${SMOKE_BASE_URL}${path}"
  if ! attempt_check "${expected}" "${url}" "${label}"; then
    fail=$((fail + 1))
  fi
done

if [ "${fail}" -gt 0 ]; then
  err "${fail} smoke check(s) failed"
  exit 1
fi
log "all smoke checks passed"
