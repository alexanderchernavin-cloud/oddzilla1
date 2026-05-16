#!/usr/bin/env bash
# Map a list of changed files (stdin) onto the set of compose services
# that need to be rebuilt. Service names are emitted space-separated
# on stdout, one line.
#
# Mapping rules (kept in lockstep with apps/web/package.json,
# services/*/package.json, and the compose service definitions):
#
#   apps/web/**                 → web1
#   services/<name>/**          → <name>
#   packages/auth/**            → api ws-gateway web1   (every TS image)
#   packages/types/**           → api ws-gateway web1
#   packages/config/**          → api ws-gateway
#   packages/db/src/**          → api                    (drizzle queries)
#   packages/db/migrations/**   → (no rebuild — handled by migrate step)
#   Caddyfile                   → caddy                  (restart only)
#   docker-compose.yml          → ALL_SERVICES           (config touch)
#   pnpm-lock.yaml | root package.json → api ws-gateway web1
#                                                        (pnpm install
#                                                         layer busts)
#
# The web service is emitted as "web1" because the compose file pins a
# shared `image: oddzilla-web:latest` across web1/web2/web3 — building
# web1 produces the image the other two start from. Recreate of web2/
# web3 happens via `make recreate-web` after the image is in place.

set -euo pipefail

declare -A SEEN

# Order all services see in compose so the output is stable + tests
# can do exact-string assertions.
ORDER=(api ws-gateway web1 signer feed-ingester odds-publisher settlement bet-delay wallet-watcher metrics-collector caddy)

mark() {
  for s in "$@"; do
    SEEN["${s}"]=1
  done
}

mark_all_built_services() {
  mark api ws-gateway web1 signer feed-ingester odds-publisher settlement bet-delay wallet-watcher metrics-collector
}

while IFS= read -r path; do
  [ -z "${path}" ] && continue
  case "${path}" in
    apps/web/*)
      mark web1 ;;
    services/api/*)
      mark api ;;
    services/ws-gateway/*)
      mark ws-gateway ;;
    services/feed-ingester/*)
      mark feed-ingester ;;
    services/odds-publisher/*)
      mark odds-publisher ;;
    services/settlement/*)
      mark settlement ;;
    services/bet-delay/*)
      mark bet-delay ;;
    services/wallet-watcher/*)
      mark wallet-watcher ;;
    services/signer/*)
      mark signer ;;
    services/metrics-collector/*)
      mark metrics-collector ;;
    packages/auth/*)
      mark api ws-gateway web1 ;;
    packages/types/*)
      mark api ws-gateway web1 ;;
    packages/config/*)
      mark api ws-gateway ;;
    packages/db/migrations/*)
      : ;;  # migrations apply via db:migrate, no image rebuild needed
    packages/db/*)
      mark api ;;
    Caddyfile)
      mark caddy ;;
    docker-compose.yml|docker-compose.*.yml)
      # A compose config change can affect every service's runtime
      # (env, mem_limit, health probe, …). Rebuild + recreate them all
      # to be safe — the cost is bounded and the alternative is a
      # subtle "old config, new docker-compose.yml" drift.
      mark_all_built_services ;;
    pnpm-lock.yaml|package.json|pnpm-workspace.yaml|turbo.json)
      mark api ws-gateway web1 ;;
    *)
      : ;;
  esac
done

# Emit in canonical order, space-separated, single line.
out=""
for s in "${ORDER[@]}"; do
  if [ -n "${SEEN[${s}]:-}" ]; then
    out="${out}${out:+ }${s}"
  fi
done
echo "${out}"
