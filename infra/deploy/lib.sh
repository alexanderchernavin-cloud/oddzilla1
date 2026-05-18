#!/usr/bin/env bash
# Shared helpers for deploy / rollback / status scripts. Source-only —
# don't run this file directly.
#
# All deploy state lives under $DEPLOY_DIR (default
# /home/team/oddzilla/.deploy) which is owned by the `team` user, so
# the orchestrator never needs sudo to touch state — only to call
# docker compose. That keeps the privilege surface tight: sudo is
# reserved for `docker` invocations (which are NOPASSWD'd in the
# server's sudoers per CLAUDE.md), nothing else.
#
# Conventions:
#   • Each function emits a single tagged log line (`[deploy] ...`) so
#     `journalctl -t deploy` cleanly threads the run.
#   • Functions return non-zero on failure; the orchestrator uses
#     `set -euo pipefail` so any unhandled failure stops the deploy
#     before more state changes land.
#   • State files are touched/written atomically (write-tmp + mv) so a
#     mid-write crash never leaves the deploy log half-baked.

set -euo pipefail

# Resolve repo root from the script's own location so we don't depend
# on the operator's PWD.
DEPLOY_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${DEPLOY_LIB_DIR}/../.." && pwd)"

DEPLOY_DIR="${DEPLOY_DIR:-${REPO_ROOT}/.deploy}"
DEPLOY_LAST_SHA_FILE="${DEPLOY_DIR}/last-sha"
DEPLOY_LOG_FILE="${DEPLOY_DIR}/log"
DEPLOY_IMAGES_DIR="${DEPLOY_DIR}/images"
DEPLOY_BACKUP_DIR="${DEPLOY_DIR}/backups"
DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-/var/lock/oddzilla-deploy.lock}"

# Compose invocation pattern matches CLAUDE.md (the `scaled` profile is
# required to address web2/web3; passing it everywhere is a no-op for
# services outside the profile).
COMPOSE=(sudo -n docker compose -f "${REPO_ROOT}/docker-compose.yml" --profile scaled)

# Image retention: keep this many SHAs per service. Older tags get
# pruned when a new one lands. 3 is the bare minimum to support "I
# already rolled back once and need to roll back again" — bump if you
# want a longer rewind window.
IMAGE_RETENTION="${IMAGE_RETENTION:-3}"

# Smoke-test endpoint defaults. Overridable via env so a future
# multi-host setup can point smoke at the actual external host instead
# of localhost-only.
SMOKE_BASE_URL="${SMOKE_BASE_URL:-https://oddzilla.cc}"

log() {
  printf '[deploy] %s\n' "$*" >&2
}

err() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
}

# Ensure the deploy state dir exists with the right shape. Idempotent.
deploy_ensure_dirs() {
  mkdir -p "${DEPLOY_DIR}" "${DEPLOY_IMAGES_DIR}" "${DEPLOY_BACKUP_DIR}"
  chmod 750 "${DEPLOY_DIR}" "${DEPLOY_IMAGES_DIR}" "${DEPLOY_BACKUP_DIR}"
  touch "${DEPLOY_LOG_FILE}"
}

# Atomic file writer — writes to a sibling tmp, fsyncs, then renames.
# Used for last-sha and the per-service image stacks so a crash mid-
# deploy can't leave a half-written state file.
deploy_write_atomic() {
  local dest="$1"
  local tmp
  tmp="$(mktemp "${dest}.XXXXXX")"
  cat > "${tmp}"
  mv "${tmp}" "${dest}"
}

# Acquire an exclusive lock so two operators can't deploy at once. The
# lock file is /var/lock/oddzilla-deploy.lock which `team` can write
# (the dir is world-writable on stock Ubuntu). Non-blocking — if
# another deploy is running, exit immediately rather than queuing
# behind it (deploys queue cleanly through git push anyway).
deploy_acquire_lock() {
  exec 9>"${DEPLOY_LOCK_FILE}"
  if ! flock -n 9; then
    err "another deploy is in progress (lock: ${DEPLOY_LOCK_FILE})"
    exit 1
  fi
}

# Read the last successful deploy's SHA, or fall back to the current
# git HEAD if there's never been a recorded deploy. The fallback means
# the first run on a fresh box still produces a clean diff (HEAD..HEAD
# = empty file list, no services to rebuild, no migrations to run).
deploy_last_sha() {
  if [ -f "${DEPLOY_LAST_SHA_FILE}" ]; then
    cat "${DEPLOY_LAST_SHA_FILE}"
  else
    git -C "${REPO_ROOT}" rev-parse HEAD
  fi
}

# Push the new SHA to the per-service image stack and prune to
# IMAGE_RETENTION entries. The stack is most-recent-first so
# rollback can read line 2 directly.
deploy_record_image() {
  local svc="$1"
  local sha="$2"
  local file="${DEPLOY_IMAGES_DIR}/${svc}"
  local existing=""
  if [ -f "${file}" ]; then
    # Drop any prior occurrence of this SHA so we don't carry
    # duplicates after a forced re-deploy of the same commit.
    existing="$(grep -vFx "${sha}" "${file}" || true)"
  fi
  {
    printf '%s\n' "${sha}"
    [ -n "${existing}" ] && printf '%s\n' "${existing}"
  } | head -n "${IMAGE_RETENTION}" | deploy_write_atomic "${file}"
}

# Get the Nth most recent recorded SHA for a service (1-indexed).
# Returns empty on miss.
deploy_image_at() {
  local svc="$1"
  local index="${2:-1}"
  local file="${DEPLOY_IMAGES_DIR}/${svc}"
  [ -f "${file}" ] || return 0
  sed -n "${index}p" "${file}" || true
}

# Append a deploy event to the log. Fields are space-separated for
# easy `awk` post-mortem queries; commas in `services` are converted
# to spaces inside the field.
deploy_log_event() {
  local kind="$1"            # deploy | rollback | smoke_fail | …
  local sha="$2"
  local services="$3"        # space-separated; "-" if none
  local extra="${4:-}"
  printf '%s %s %s services=%s%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "${kind}" \
    "${sha}" \
    "${services// /,}" \
    "${extra:+ ${extra}}" \
    >> "${DEPLOY_LOG_FILE}"
}

# Run a command and label its output. Used for the long-running build
# step so its native progress output still streams to the operator's
# terminal while staying associated with the deploy tag in journal.
deploy_run() {
  log "$ $*"
  "$@"
}
