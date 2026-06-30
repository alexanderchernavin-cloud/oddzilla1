#!/usr/bin/env bash
# Bootstrap the host directory that holds the team-logo library for the
# /logos browser. Caddy serves this directory at /logos/* on the public
# host (see Caddyfile + docker-compose.yml caddy.volumes).
#
# Run once on the production box as root:
#   sudo bash infra/hetzner/oddzilla-logos-init.sh
#
# Then push the logo tree from a workstation with:
#   bash infra/hetzner/oddzilla-logos-sync.sh <user>@oddzilla.cc
# (or any rsync that lands files under /srv/oddzilla-logos).

set -euo pipefail

DIR=/srv/oddzilla-logos

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

mkdir -p "${DIR}"
chown root:root "${DIR}"
# 755: world-readable so the Caddy container (any uid) can read; only root
# can write — logo syncs land via rsync as the deploy user with sudo, or a
# dedicated uploader, never the Caddy container (mount is :ro).
chmod 755 "${DIR}"

ls -ld "${DIR}"
echo
echo "OK — logo library directory ready at ${DIR}."
echo "Sync logos into it (rsync), then recreate Caddy so the new mount is"
echo "picked up: sudo -n docker compose up -d --no-deps caddy"
echo "Served at https://oddzilla.cc/logos/<Sport>/<Category>/<League>/<Team>.png"
