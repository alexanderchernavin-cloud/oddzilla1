// Liveness signal for the container healthcheck.
//
// Deliberately a file rather than an HTTP endpoint: this worker dials OUT
// and has no listening socket, and keeping it that way inside the docker
// stack means one less thing reachable on the docker network. Compose sets
// LIVENESS_FILE; a PC-side run leaves it unset and this is a no-op.
//
// It is a LIVENESS signal, not readiness. The poll loop touches it at the
// top of each tick, BEFORE the API call, so an API outage doesn't get the
// container killed and restarted into the same outage — only a wedged or
// dead loop stops the file going stale. The parked path (missing creds)
// touches it too: a service idling correctly because it has no credentials
// is healthy by this repo's graceful-idle convention, not broken.

import { writeFileSync } from "node:fs";

export function touchLiveness(): void {
  const path = process.env.LIVENESS_FILE?.trim();
  if (!path) return;
  try {
    writeFileSync(path, String(Date.now()));
  } catch {
    // Never let a read-only or full filesystem take the worker down. A
    // failing healthcheck is a better outcome than a dead loop.
  }
}
