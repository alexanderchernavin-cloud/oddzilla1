#!/usr/bin/env bash
# Roll the running containers back to the previous deploy by
# retagging the prior `oddzilla-<svc>:<sha>` images to `:latest` and
# force-recreating the services that were touched in the last deploy.
#
# What rollback does NOT do:
#   • Roll back DB migrations. Our convention is forward-only,
#     nullable-additive: a previous code version can read a newer
#     schema cleanly (extra columns are ignored, new tables aren't
#     queried). Reverting a destructive migration is a separate,
#     manual operation — restore from the pre-deploy snapshot under
#     $DEPLOY_DIR/backups/.
#   • Roll back the git worktree. Source stays at the failed deploy
#     SHA so the operator can fix-forward without re-pulling. If you
#     want full revert (code + containers), run `git reset --hard`
#     after this script.
#
# Usage:
#   ./rollback.sh                  # roll back the most recent deploy
#   ./rollback.sh <to-sha>         # roll back to a specific SHA from
#                                  # the .deploy/images/ manifests

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

deploy_ensure_dirs
deploy_acquire_lock

if [ ! -s "${DEPLOY_LOG_FILE}" ]; then
  err "no deploy log at ${DEPLOY_LOG_FILE} — nothing to roll back"
  exit 1
fi

# The last `deploy` event in the log is what we're rolling back FROM.
# We need its services list to know what to recreate.
LAST_DEPLOY_LINE="$(grep -E '^[0-9TZ:-]+ deploy ' "${DEPLOY_LOG_FILE}" | tail -1 || true)"
if [ -z "${LAST_DEPLOY_LINE}" ]; then
  err "no deploy events in log — nothing to roll back"
  exit 1
fi

FROM_SHA="$(echo "${LAST_DEPLOY_LINE}" | awk '{print $3}')"
SERVICES_FIELD="$(echo "${LAST_DEPLOY_LINE}" | grep -oE 'services=[^ ]+' | cut -d= -f2)"
SERVICES="$(echo "${SERVICES_FIELD}" | tr ',' ' ')"

# Resolve the rollback target. Default: the SHA *before* FROM_SHA in
# the per-service image stack (line 2 of every manifest — they all
# should agree if the deploys touched overlapping services; we just
# pick the union per service).
if [ "$#" -ge 1 ]; then
  TO_SHA="$1"
else
  TO_SHA=""
fi

if [ -z "${SERVICES}" ] || [ "${SERVICES}" = "-" ]; then
  err "last deploy recorded zero services — nothing to recreate"
  exit 1
fi

log "rolling back deploy from ${FROM_SHA:0:12}"
log "services to revert: ${SERVICES}"

# Verify every service has a recorded prior image before doing
# anything destructive. If even one is missing, abort — partial
# rollbacks leave the stack in a mismatched-code state which is
# worse than the failed deploy we're trying to undo.
declare -A REVERT_SHA
for svc in ${SERVICES}; do
  if [ -n "${TO_SHA}" ]; then
    target="${TO_SHA}"
  else
    # Line 1 of the manifest is the current SHA (the one we're
    # rolling back from); line 2 is the previous deploy's SHA.
    target="$(deploy_image_at "${svc}" 2)"
  fi
  if [ -z "${target}" ]; then
    err "no prior image recorded for ${svc} (manifest: ${DEPLOY_IMAGES_DIR}/${svc})"
    err "rollback aborted before any retag"
    exit 1
  fi

  image_name="oddzilla-${svc%1}"
  if [ "${svc}" = "web1" ] || [ "${svc}" = "web2" ] || [ "${svc}" = "web3" ]; then
    image_name="oddzilla-web"
  fi

  if ! sudo -n docker image inspect "${image_name}:${target}" >/dev/null 2>&1; then
    err "image ${image_name}:${target} not present on host"
    err "rollback aborted before any retag"
    exit 1
  fi
  REVERT_SHA["${svc}"]="${target}"
  log "  ${svc}: revert to ${target:0:12} (${image_name}:${target})"
done

# Retag :latest to the prior SHA for each service. Retagging is
# instantaneous; it's the recreate below that actually flips traffic.
for svc in ${SERVICES}; do
  target="${REVERT_SHA[${svc}]}"
  image_name="oddzilla-${svc%1}"
  if [ "${svc}" = "web1" ] || [ "${svc}" = "web2" ] || [ "${svc}" = "web3" ]; then
    image_name="oddzilla-web"
  fi
  log "tag ${image_name}:${target:0:12} → ${image_name}:latest"
  sudo -n docker tag "${image_name}:${target}" "${image_name}:latest"
done

# Recreate non-web first, then roll web.
NON_WEB="$(echo "${SERVICES}" | tr ' ' '\n' | grep -v '^web' | tr '\n' ' ' | sed 's/ $//')"
if [ -n "${NON_WEB}" ]; then
  log "recreating: ${NON_WEB}"
  # shellcheck disable=SC2086
  "${COMPOSE[@]}" up -d --no-deps --force-recreate ${NON_WEB}
fi

if echo "${SERVICES}" | tr ' ' '\n' | grep -qx web1; then
  log "rolling-recreating web1 → web2 → web3"
  make -C "${REPO_ROOT}" recreate-web
fi

# The last-sha pointer goes back to the rollback target so a
# subsequent `deploy status` shows the right delta. Use the first
# service's revert SHA as the canonical pointer; in practice they all
# match because deploys move every service forward together.
FIRST_SVC="$(echo "${SERVICES}" | awk '{print $1}')"
ROLLED_TO="${REVERT_SHA[${FIRST_SVC}]}"
printf '%s\n' "${ROLLED_TO}" | deploy_write_atomic "${DEPLOY_LAST_SHA_FILE}"

deploy_log_event rollback "${ROLLED_TO}" "${SERVICES}" "from=${FROM_SHA}"

log "rollback to ${ROLLED_TO:0:12} complete"
log "git worktree is still at ${FROM_SHA:0:12} — run 'git -C ${REPO_ROOT} reset --hard ${ROLLED_TO}' if you want code to match"

# Run smoke after the rollback so we know whether the prior version
# is healthy. A rollback that doesn't pass smoke is a serious incident
# (the previous deploy WAS healthy when it landed); surface it loud.
if "${SCRIPT_DIR}/smoke.sh"; then
  log "rollback verified healthy"
else
  err "rollback completed but smoke is failing — investigate immediately"
  exit 1
fi
