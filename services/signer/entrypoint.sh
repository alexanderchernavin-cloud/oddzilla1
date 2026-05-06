#!/bin/sh
# Take ownership of the shared socket volume (mounted from compose as
# root:root by default) and drop privileges to the unprivileged signer
# user before exec'ing the binary. After the chown, the api container
# can connect to the socket as long as it runs as UID 1000 (it does).

set -eu

SOCK_DIR="${SIGNER_SOCKET_PATH:-/run/signer/signer.sock}"
SOCK_DIR="$(dirname "$SOCK_DIR")"

mkdir -p "$SOCK_DIR"
chown signer:signer "$SOCK_DIR"
chmod 0750 "$SOCK_DIR"

exec su-exec signer:signer /usr/local/bin/signer
