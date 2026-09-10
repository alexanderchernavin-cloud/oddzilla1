#!/usr/bin/env bash
# Exercise the CI gate's classification against real change sets.
# The three grep patterns are copied VERBATIM from .github/workflows/ci.yml;
# if they drift, this test stops proving anything, so keep them in step.
set -uo pipefail

classify() {
  local files="$1" go ts db
  if echo "$files" | grep -qE '^\.github/workflows/ci\.yml$'; then
    echo "true true true"; return
  fi
  match() { echo "$files" | grep -qE "$1"; }
  if match '^services/(feed-ingester|fonbet-ingester|odds-publisher|settlement|bet-delay|wallet-watcher|signer|slotzilla)/'; then go=true; else go=false; fi
  if match '^(apps/|packages/|services/(api|ws-gateway|support-ai-bot|zillaboost-banner-gen)/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig)'; then ts=true; else ts=false; fi
  if match '^packages/db/(migrations/|src/schema/|src/migrate)'; then db=true; else db=false; fi
  echo "$go $ts $db"
}

fail=0
check() {
  local name="$1" want="$2" files="$3"
  local got
  got=$(classify "$files")
  if [ "$got" = "$want" ]; then
    printf '  ok   %-42s go/ts/db = %s\n' "$name" "$got"
  else
    printf '  FAIL %-42s want [%s] got [%s]\n' "$name" "$want" "$got"
    fail=1
  fi
}

echo "gate classification (go ts db):"

check "today's filter-chip PR" "false true false" \
'apps/web/src/app/(main)/sport/[slug]/page.tsx
apps/web/src/components/ui/logo-mark.tsx
apps/web/messages/en.json
services/api/src/modules/catalog/routes.ts'

check "a Go ingester change" "true false false" \
'services/feed-ingester/internal/store/markets.go
services/feed-ingester/go.sum'

check "a migration + schema" "false true true" \
'packages/db/migrations/0111_thing.sql
packages/db/src/schema/catalog.ts'

check "docs only" "false false false" \
'CLAUDE.md
docs/OPERATIONS.md'

check "the workflow itself" "true true true" \
'.github/workflows/ci.yml'

check "lockfile bump" "false true false" \
'pnpm-lock.yaml
package.json'

check "mixed Go + TS" "true true false" \
'services/settlement/internal/settler/settler.go
services/api/src/modules/bets/service.ts'

check "shared types package" "false true false" \
'packages/types/src/odds.ts'

check "infra script only" "false false false" \
'infra/deploy/deploy.sh'

check "a Go service NOT in the matrix" "false false false" \
'services/mail-receiver/main.go'

check "db package but not schema/migrations" "false true false" \
'packages/db/src/resolve-logos.ts'

check "another workflow file" "false false false" \
'.github/workflows/android.yml'

check "the slotzilla service" "true false false" \
'services/slotzilla/internal/engine/engine.go
services/slotzilla/go.sum'

exit $fail
