#!/usr/bin/env bash
# One-shot deploy: fetch → diff → backup-if-migrations → migrate →
# build-changed → recreate → smoke. Records the SHA + service set in
# the deploy log on success.
#
# Steps are explicit so a partial failure leaves clean state:
#   • git reset --hard happens AFTER the diff is computed (so a failed
#     migrate can `git reset` back manually if needed).
#   • last-sha is only updated after every recreate succeeded — a
#     failed deploy preserves the previous SHA so `status.sh` still
#     shows the right delta on the retry.
#   • smoke failure does NOT roll back automatically (the operator may
#     prefer to investigate); it exits non-zero AFTER recording the
#     event so the rollback command works from the just-written log.
#
# Concurrent runs are blocked via flock — see lib.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

deploy_ensure_dirs
deploy_acquire_lock

# ── 1. Sync git ─────────────────────────────────────────────────────
log "fetching origin/main"
deploy_run git -C "${REPO_ROOT}" fetch origin main

CURRENT_SHA="$(deploy_last_sha)"
TARGET_SHA="$(git -C "${REPO_ROOT}" rev-parse origin/main)"

if [ "${CURRENT_SHA}" = "${TARGET_SHA}" ]; then
  log "already at ${TARGET_SHA} — nothing to deploy"
  exit 0
fi

log "deploying ${CURRENT_SHA} → ${TARGET_SHA}"

# Compute the diff BEFORE moving HEAD so a misconfigured remote doesn't
# leave us in a weird in-between state. `git diff a..b` works even if
# `a` is no longer reachable from HEAD as long as the object exists,
# but we want to be safe.
CHANGED_FILES="$(git -C "${REPO_ROOT}" diff --name-only "${CURRENT_SHA}..${TARGET_SHA}")"
SERVICES="$(printf '%s\n' "${CHANGED_FILES}" | bash "${SCRIPT_DIR}/detect-services.sh")"

# Migration detection: any new file under packages/db/migrations/
# matching the standard 4-digit prefix. Renames / deletes also touch
# the path, but our convention is forward-only additive, so a hit
# here always means "drizzle has new SQL to apply".
MIGRATIONS_PENDING="$(printf '%s\n' "${CHANGED_FILES}" | grep -cE '^packages/db/migrations/[0-9].*\.sql$' || true)"

# Caddy is a config-restart only (no Dockerfile build); strip it from
# the build list and handle it separately at recreate time. Use awk
# (not grep -v) so a "no caddy in the list" case doesn't trip the
# pipefail-set -e combo when the filter matches zero lines.
NEED_CADDY_RELOAD=0
if printf '%s\n' "${SERVICES}" | tr ' ' '\n' | awk '$0 == "caddy" { found=1 } END { exit !found }'; then
  NEED_CADDY_RELOAD=1
  SERVICES="$(printf '%s\n' "${SERVICES}" | tr ' ' '\n' | awk '$0 != "caddy" && NF' | tr '\n' ' ' | sed 's/ $//')"
fi

log "changed services:    ${SERVICES:-<none>}"
log "migrations pending:  ${MIGRATIONS_PENDING}"
log "caddy reload:        ${NEED_CADDY_RELOAD}"

# ── 2. Apply git ────────────────────────────────────────────────────
log "fast-forwarding worktree"
deploy_run git -C "${REPO_ROOT}" reset --hard "${TARGET_SHA}"

# ── 3. Pre-migration backup (only if there's something to migrate) ──
if [ "${MIGRATIONS_PENDING}" -gt 0 ]; then
  log "running pre-deploy pg snapshot"
  deploy_run bash "${SCRIPT_DIR}/dump-db.sh" "${TARGET_SHA}"
fi

# ── 4. Migrations ───────────────────────────────────────────────────
if [ "${MIGRATIONS_PENDING}" -gt 0 ]; then
  log "applying migrations"
  # DATABASE_URL in .env points at host `postgres` (the compose
  # service name) for in-container resolution. The migrate runner
  # runs ON the host, so we rewrite to 127.0.0.1 where postgres
  # binds via the compose `ports:` entry.
  set -a
  # shellcheck disable=SC1090
  . "${REPO_ROOT}/.env"
  set +a
  export DATABASE_URL="${DATABASE_URL//@postgres:/@127.0.0.1:}"
  deploy_run pnpm --filter @oddzilla/db db:migrate
fi

# ── 5. Build changed services ───────────────────────────────────────
if [ -n "${SERVICES}" ]; then
  log "building services in parallel: ${SERVICES}"
  # Drop the per-service serial loop. CPX31 (8 GB) handles parallel
  # builds; if a future regression OOMs again, set
  # DEPLOY_BUILD_PARALLEL_CAP=2 (or another cap) and re-run — that
  # maps onto Compose's COMPOSE_PARALLEL_LIMIT.
  if [ -n "${DEPLOY_BUILD_PARALLEL_CAP:-}" ]; then
    export COMPOSE_PARALLEL_LIMIT="${DEPLOY_BUILD_PARALLEL_CAP}"
    log "parallel build cap: ${DEPLOY_BUILD_PARALLEL_CAP}"
  fi
  # shellcheck disable=SC2086
  deploy_run "${COMPOSE[@]}" build ${SERVICES}

  log "tagging :${TARGET_SHA:0:12} on built images"
  # shellcheck disable=SC2086
  deploy_run bash "${SCRIPT_DIR}/tag-images.sh" "${TARGET_SHA}" ${SERVICES}
fi

# ── 6. Recreate non-web services ────────────────────────────────────
# awk filter instead of `grep -v '^web'` so a list of only web1
# (which matches the prefix and produces zero output lines) doesn't
# trip pipefail+set -e. Same pattern below for the web1 detection.
NON_WEB="$(printf '%s\n' "${SERVICES}" | tr ' ' '\n' | awk '$1 != "" && $1 !~ /^web/' | tr '\n' ' ' | sed 's/ $//')"
if [ -n "${NON_WEB}" ]; then
  log "recreating: ${NON_WEB}"
  # shellcheck disable=SC2086
  deploy_run "${COMPOSE[@]}" up -d --no-deps --force-recreate ${NON_WEB}
fi

# ── 7. Rolling recreate of web replicas ─────────────────────────────
if printf '%s\n' "${SERVICES}" | tr ' ' '\n' | awk '$0 == "web1" { found=1 } END { exit !found }'; then
  log "rolling-recreating web1 → web2 → web3"
  deploy_run make -C "${REPO_ROOT}" recreate-web
fi

# ── 8. Caddy reload (config-only change, no Dockerfile build) ──────
if [ "${NEED_CADDY_RELOAD}" -eq 1 ]; then
  log "reloading caddy config"
  # `docker exec caddy reload` validates the file before reloading
  # and emits the parse error to stderr; a bad Caddyfile leaves the
  # current config running unchanged.
  deploy_run sudo -n docker exec oddzilla-caddy-1 caddy reload --config /etc/caddy/Caddyfile
fi

# ── 9. Record success BEFORE smoke ──────────────────────────────────
# Rationale: if smoke fails, we want `rollback.sh` to be able to read
# this deploy out of the log and revert it. Marking success here also
# means a subsequent re-run computes diff from the new SHA, not from
# the previous one — otherwise the next deploy would re-do this work.
printf '%s\n' "${TARGET_SHA}" | deploy_write_atomic "${DEPLOY_LAST_SHA_FILE}"
deploy_log_event deploy "${TARGET_SHA}" "${SERVICES:--}" "migrations=${MIGRATIONS_PENDING}"

# ── 10. Smoke ───────────────────────────────────────────────────────
if bash "${SCRIPT_DIR}/smoke.sh"; then
  log "deploy ${TARGET_SHA:0:12} complete"
else
  deploy_log_event smoke_fail "${TARGET_SHA}" "${SERVICES:--}"
  err "deploy ${TARGET_SHA:0:12} reached recreate but smoke failed"
  err "investigate, then either fix forward or run: make rollback"
  exit 1
fi
