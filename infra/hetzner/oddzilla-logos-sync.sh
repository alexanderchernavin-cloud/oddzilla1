#!/usr/bin/env bash
# Push the local team-logo tree to the production host's /srv/oddzilla-logos,
# which Caddy serves at /logos/* (see Caddyfile). Idempotent: rsync only
# transfers new/changed files, so re-running after a fresh download is cheap.
#
# Usage:
#   bash infra/hetzner/oddzilla-logos-sync.sh deploy@oddzilla.cc
#
# Source is the synced web copy (apps/web/public/logos), which already holds
# the full tree + manifest.json. Regenerate it first from the source
# collection with the Logos project's sync-to-web.py if you just downloaded
# new logos.
#
# Requires rsync + ssh on the workstation. On Windows use Git Bash/WSL, or
# run this from any machine that has the repo checked out and the tree synced.

set -euo pipefail

REMOTE="${1:?usage: oddzilla-logos-sync.sh <user>@<host>}"
DEST="${2:-/srv/oddzilla-logos}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../apps/web/public/logos" && pwd)/"

if [[ ! -f "${SRC}manifest.json" ]]; then
  echo "no manifest at ${SRC} — run sync-to-web.py first" >&2
  exit 1
fi

echo "Syncing ${SRC}"
echo "     -> ${REMOTE}:${DEST}"
# --delete keeps the host in lockstep with the local tree (removes logos
# deleted locally). Drop it if you ever want the host to retain extras.
# Files land root-owned via the deploy user's sudo rsync wrapper, or adjust
# --rsync-path as your host's permissions require.
rsync -avz --delete \
  --chmod=D755,F644 \
  "${SRC}" "${REMOTE}:${DEST}/"

echo
echo "Done. If this is the first sync after adding the compose mount, recreate"
echo "Caddy on the host: sudo -n docker compose up -d --no-deps caddy"
