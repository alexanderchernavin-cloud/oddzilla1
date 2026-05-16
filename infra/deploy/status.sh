#!/usr/bin/env bash
# Show what `deploy.sh` would do without touching anything. Safe to
# run anywhere — purely a read-only summary.
#
# Output is human-readable; if you need machine-parseable, grep
# specific labels (`services:`, `migrations:`, …) which are stable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "${SCRIPT_DIR}/lib.sh"

deploy_ensure_dirs

CURRENT_SHA="$(deploy_last_sha)"
git -C "${REPO_ROOT}" fetch --quiet origin main
TARGET_SHA="$(git -C "${REPO_ROOT}" rev-parse origin/main)"

echo "current deployed sha:  ${CURRENT_SHA}"
echo "origin/main sha:       ${TARGET_SHA}"

if [ "${CURRENT_SHA}" = "${TARGET_SHA}" ]; then
  echo
  echo "up to date — no deploy needed"
  exit 0
fi

echo
echo "commits to deploy:"
git -C "${REPO_ROOT}" log --oneline "${CURRENT_SHA}..${TARGET_SHA}"

CHANGED_FILES="$(git -C "${REPO_ROOT}" diff --name-only "${CURRENT_SHA}..${TARGET_SHA}")"
SERVICES="$(printf '%s\n' "${CHANGED_FILES}" | "${SCRIPT_DIR}/detect-services.sh")"
MIGRATION_FILES="$(printf '%s\n' "${CHANGED_FILES}" | grep -E '^packages/db/migrations/[0-9].*\.sql$' || true)"

echo
echo "services to rebuild:   ${SERVICES:-<none>}"
if [ -n "${MIGRATION_FILES}" ]; then
  echo "migrations to apply:"
  printf '  %s\n' ${MIGRATION_FILES}
else
  echo "migrations to apply:   <none>"
fi

echo
echo "last 5 deploy events:"
tail -n 5 "${DEPLOY_LOG_FILE}" 2>/dev/null | sed 's/^/  /' || true
