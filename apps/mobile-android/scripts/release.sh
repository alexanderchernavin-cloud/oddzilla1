#!/usr/bin/env bash
# Build a signed release APK and ship it to the production server.
#
# Run from apps/mobile-android:
#
#   ./scripts/release.sh "release notes here"
#
# Env overrides:
#   MANDATORY=1                       force-update flag
#   MIN_SUPPORTED_CODE=N              retire builds below this code
#   SKIP_BUILD=1                      reuse existing APK
#   DRY_RUN=1                         build only, don't push
#   SERVER=team@178.104.174.24        ssh target
#   REMOTE_DIR=/srv/oddzilla-apk      remote drop dir
#
# Prereqs: same as release.ps1. See that file for details.

set -euo pipefail

RELEASE_NOTES="${1:-}"
SERVER="${SERVER:-team@178.104.174.24}"
REMOTE_DIR="${REMOTE_DIR:-/srv/oddzilla-apk}"
MANDATORY="${MANDATORY:-0}"
MIN_SUPPORTED_CODE="${MIN_SUPPORTED_CODE:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
DRY_RUN="${DRY_RUN:-0}"

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"

# 1. Read version.properties.
test -f version.properties || { echo "version.properties missing"; exit 1; }
VERSION_CODE=$(awk -F'=' '/^versionCode=/{print $2}' version.properties | tr -d '[:space:]')
VERSION_NAME=$(awk -F'=' '/^versionName=/{print $2}' version.properties | tr -d '[:space:]')
echo "Releasing v$VERSION_NAME ($VERSION_CODE)"

# 2. Verify keystore.
test -f keystore.properties || { echo "keystore.properties missing — see keystore.properties.example"; exit 1; }

# 3. Build (unless skipped).
APK="$PROJECT_ROOT/app/build/outputs/apk/release/app-release.apk"
if [[ "$SKIP_BUILD" != "1" ]]; then
  test -x "$PROJECT_ROOT/gradlew" || { echo "gradlew missing. Open in Android Studio once or run 'gradle wrapper'."; exit 1; }
  echo "Building :app:assembleRelease..."
  ./gradlew :app:assembleRelease --no-daemon
fi
test -f "$APK" || { echo "APK not found at $APK"; exit 1; }

# 4. Hash.
if command -v sha256sum >/dev/null 2>&1; then
  SHA256=$(sha256sum "$APK" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  SHA256=$(shasum -a 256 "$APK" | awk '{print $1}')
else
  echo "no sha256sum or shasum available"
  exit 1
fi
echo "SHA-256: $SHA256"

# 5. Manifest JSON.
APK_REMOTE_NAME="oddzilla-$VERSION_NAME.apk"
APK_URL="https://oddzilla.cc/app/$APK_REMOTE_NAME"
# Escape backslashes + double quotes in releaseNotes for JSON safety.
NOTES_ESCAPED=$(printf '%s' "$RELEASE_NOTES" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read())[1:-1])' 2>/dev/null || true)
if [[ -z "$NOTES_ESCAPED" ]]; then
  # Fallback if python3 isn't available — strict double-quote escape.
  NOTES_ESCAPED=$(printf '%s' "$RELEASE_NOTES" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
fi

MANDATORY_BOOL=false
[[ "$MANDATORY" == "1" ]] && MANDATORY_BOOL=true

read -r -d '' MANIFEST <<JSON || true
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "apkUrl": "$APK_URL",
  "sha256": "$SHA256",
  "releaseNotes": "$NOTES_ESCAPED",
  "mandatory": $MANDATORY_BOOL,
  "minSupportedVersionCode": $MIN_SUPPORTED_CODE
}
JSON

if [[ "$DRY_RUN" == "1" ]]; then
  echo "DryRun — would upload:"
  echo "  apk: $APK -> $SERVER:$REMOTE_DIR/$APK_REMOTE_NAME"
  echo "  version.json:"
  echo "$MANIFEST"
  exit 0
fi

# 6. SCP both files to /tmp on the server, then atomically install
#    them into the protected /srv/oddzilla-apk directory.
TMP_APK="/tmp/$APK_REMOTE_NAME"
TMP_JSON="/tmp/version.json"
echo "Uploading APK..."
scp "$APK" "$SERVER:$TMP_APK"

TMP_LOCAL_JSON=$(mktemp)
printf '%s\n' "$MANIFEST" > "$TMP_LOCAL_JSON"
echo "Uploading manifest..."
scp "$TMP_LOCAL_JSON" "$SERVER:$TMP_JSON"
rm -f "$TMP_LOCAL_JSON"

echo "Promoting to $REMOTE_DIR..."
ssh "$SERVER" "set -e; \
sudo install -o root -g root -m 644 $TMP_APK $REMOTE_DIR/$APK_REMOTE_NAME; \
sudo install -o root -g root -m 644 $TMP_JSON $REMOTE_DIR/version.json; \
rm -f $TMP_APK $TMP_JSON; \
ls -l $REMOTE_DIR"

echo
echo "Released v$VERSION_NAME ($VERSION_CODE)."
echo "  $APK_URL"
echo "  https://oddzilla.cc/app/version.json"
