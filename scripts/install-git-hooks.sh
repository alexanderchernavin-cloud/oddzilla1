#!/usr/bin/env bash
# Installs an opt-in pre-push hook that runs gitleaks on outgoing commits.
#
# Usage:
#   bash scripts/install-git-hooks.sh
#
# Requires `gitleaks` on PATH (e.g. `brew install gitleaks`). If gitleaks
# isn't installed at push time the hook skips silently so it never blocks
# a teammate who hasn't opted in.
#
# Bypass a single push with `git push --no-verify` (use sparingly — CI will
# still run the same scan and block the merge).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK_PATH="$REPO_ROOT/.git/hooks/pre-push"

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
# Pre-push secret scan via gitleaks. Installed by scripts/install-git-hooks.sh.
set -euo pipefail

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[pre-push] gitleaks not installed — skipping. brew install gitleaks to enable." >&2
  exit 0
fi

zero="0000000000000000000000000000000000000000"

while read -r local_ref local_sha remote_ref remote_sha; do
  # Branch deletion: nothing to scan.
  [[ "$local_sha" == "$zero" ]] && continue

  if [[ "$remote_sha" == "$zero" ]]; then
    # New branch: scan commits unique to this branch.
    log_opts="$local_sha --not --remotes"
  else
    log_opts="$remote_sha..$local_sha"
  fi

  if ! gitleaks detect --redact --no-banner --exit-code=1 --log-opts="$log_opts"; then
    echo "" >&2
    echo "[pre-push] Secrets detected in commits being pushed. Push aborted." >&2
    echo "[pre-push] Remove the secrets, rotate the credential, and amend/rewrite the commit." >&2
    echo "[pre-push] If this is a false positive, add an allowlist entry to .gitleaks.toml or push with --no-verify." >&2
    exit 1
  fi
done

exit 0
HOOK

chmod +x "$HOOK_PATH"
echo "Installed pre-push hook at $HOOK_PATH"
echo "Tip: brew install gitleaks (macOS) or see https://github.com/gitleaks/gitleaks for other platforms."
