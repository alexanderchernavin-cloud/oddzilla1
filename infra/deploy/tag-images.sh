#!/usr/bin/env bash
# After `docker compose build` has produced fresh `oddzilla-<svc>:latest`
# tags, this script:
#   1. Adds an additional `:<sha>` tag to each just-built service.
#   2. Updates the per-service rollback manifest under
#      $DEPLOY_DIR/images/<svc> (most-recent-first SHA stack, capped at
#      $IMAGE_RETENTION entries).
#   3. Prunes any locally-stored SHA tags that fell off the manifest —
#      so the host doesn't accumulate stale images indefinitely.
#
# The `:latest` tag is left untouched: docker compose recreate reads
# `:latest`, and rollback flips `:latest` back to a recorded older SHA.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

if [ "$#" -lt 2 ]; then
  err "usage: tag-images.sh <sha> <service> [<service>...]"
  exit 2
fi

SHA="$1"
shift

deploy_ensure_dirs

for svc in "$@"; do
  local_image="oddzilla-${svc%1}"
  # web1/web2/web3 share `oddzilla-web:latest` (the compose `image:`
  # directive in x-web-base pins that name). Strip the trailing "1"
  # so we tag the shared image.
  if [ "${svc}" = "web1" ] || [ "${svc}" = "web2" ] || [ "${svc}" = "web3" ]; then
    local_image="oddzilla-web"
  fi

  # Confirm the :latest tag actually exists. If it doesn't, the build
  # step silently dropped this service — fail loudly so the operator
  # notices instead of recording a phantom deploy.
  if ! sudo -n docker image inspect "${local_image}:latest" >/dev/null 2>&1; then
    err "expected ${local_image}:latest after build, not found"
    exit 1
  fi

  log "tagging ${local_image}:${SHA}"
  sudo -n docker tag "${local_image}:latest" "${local_image}:${SHA}"

  # Push onto the rollback stack (most-recent-first, capped at
  # IMAGE_RETENTION). The stack is the source of truth for rollback;
  # it must include this SHA before we prune anything.
  deploy_record_image "${svc}" "${SHA}"

  # Prune any local SHA tags for this image that aren't in the stack.
  # This keeps disk usage bounded — without this, every deploy leaves
  # an additional copy of the image around forever, and the box's
  # /var/lib/docker dir grows unbounded.
  keepers="$(cat "${DEPLOY_IMAGES_DIR}/${svc}" 2>/dev/null || true)"
  while IFS= read -r tag; do
    [ -z "${tag}" ] && continue
    # `latest` and any keeper SHA stay. Everything else goes. The grep
    # uses fixed-string + line-anchored so an accidentally shorter
    # prefix doesn't match a longer keeper.
    if [ "${tag}" = "latest" ]; then continue; fi
    if printf '%s\n' "${keepers}" | grep -qFx "${tag}"; then continue; fi
    log "pruning ${local_image}:${tag}"
    sudo -n docker rmi "${local_image}:${tag}" >/dev/null 2>&1 || true
  done < <(sudo -n docker image ls --format '{{.Tag}}' "${local_image}")
done

# Free anonymous "<none>" layers that fell off after rmi above. Docker
# doesn't gc them until a `docker image prune`, and on a busy box
# that's a meaningful chunk of disk.
sudo -n docker image prune -f >/dev/null 2>&1 || true
