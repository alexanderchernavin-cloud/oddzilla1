#!/usr/bin/env bash
# Bootstrap the host directory that holds Android APK releases for the
# Oddzilla mobile app. Caddy serves this directory at /app/* on the
# public host (see Caddyfile + docker-compose.yml caddy.volumes).
#
# Run once on the production box as root:
#   sudo bash infra/hetzner/oddzilla-apk-init.sh
#
# Subsequent releases drop in via the apps/mobile-android/scripts/release.*
# scripts: scp the new APK + an updated version.json, that's it.

set -euo pipefail

DIR=/srv/oddzilla-apk

if [[ "${EUID}" -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

mkdir -p "${DIR}"
chown root:root "${DIR}"
# 755: world-readable so the Caddy container (any uid) can read; only
# root can write — APK uploads use scp as the team user with sudo or
# a dedicated deploy uploader.
chmod 755 "${DIR}"

# Seed an empty manifest so the Android app boots cleanly even before
# the first release. version.json with versionCode=0 means "no update
# available for any build" — the app will treat itself as up to date.
if [[ ! -f "${DIR}/version.json" ]]; then
  cat > "${DIR}/version.json" <<'JSON'
{
  "versionCode": 0,
  "versionName": "0.0.0",
  "apkUrl": null,
  "sha256": null,
  "releaseNotes": "No release published yet.",
  "mandatory": false,
  "minSupportedVersionCode": 0
}
JSON
  chmod 644 "${DIR}/version.json"
fi

ls -l "${DIR}"
echo
echo "OK — APK distribution directory ready at ${DIR}."
echo "Caddy will serve it at https://oddzilla.cc/app/* once the compose"
echo "stack is recreated (sudo -n docker compose up -d --no-deps caddy)."
