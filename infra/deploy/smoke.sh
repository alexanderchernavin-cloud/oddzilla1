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
# Exit codes:
#   0  all green
#   1  one or more checks failed
#   2  bad invocation

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

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

fail=0
for entry in "${CHECKS[@]}"; do
  expected="${entry%%:*}"
  rest="${entry#*:}"
  path="${rest%%:*}"
  label="${rest#*:}"

  url="${SMOKE_BASE_URL}${path}"
  # -s silent, -o discard body, -w status only, --max-time bounds the
  # check. -k NOT set — production has a valid Let's Encrypt cert; if
  # TLS breaks we want the smoke to fail.
  actual="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${url}" || echo 000)"
  if [ "${actual}" = "${expected}" ]; then
    log "OK   ${actual} ${label}"
  else
    err "FAIL ${actual} (want ${expected}) ${label} — ${url}"
    fail=$((fail + 1))
  fi
done

if [ "${fail}" -gt 0 ]; then
  err "${fail} smoke check(s) failed"
  exit 1
fi
log "all smoke checks passed"
