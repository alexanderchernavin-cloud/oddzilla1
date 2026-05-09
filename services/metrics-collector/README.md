# metrics-collector

Tiny Go service that exposes host + container metrics over HTTP for the
admin /monitoring page.

## Why a separate container?

The api container holds JWT secrets, the wallet ledger, and the path
that places real-money bets. To read host CPU / memory / disk usage and
list Docker containers we need three sensitive bind mounts:

| Mount | Why |
| --- | --- |
| `/proc:/host/proc:ro` | CPU jiffies, meminfo, loadavg, uptime |
| `/:/host-root:ro,rprivate` | `statvfs()` on the host root for disk usage |
| `/var/run/docker.sock:/var/run/docker.sock:ro` | List containers + their health state |

Mounting these on the api container would mean a future API RCE could
also read host secrets (e.g. operator `~/.ssh`) and reach the docker
engine. Putting them on a separate container with no other privileges
contains the blast radius — the same reason `services/signer` is
isolated.

## Endpoints

```
GET /healthz   → { "status": "ok", "uptimeSeconds": N }
GET /snapshot  → { "ts": …, "host": {…}, "containers": [{…}] }
```

`/snapshot` returns one merged JSON object covering:

- `host.cpuPct` — active CPU% over the interval since the last call.
  `null` on the first call after process start (no baseline yet).
- `host.loadAvg` — 1m / 5m / 15m system load.
- `host.memory` — total / used / free bytes plus pct. "Used" is
  `total - available`, matching `htop` and `free -m`.
- `host.swap` — same shape as memory; `usedPct` is 0 if the host has no
  swap.
- `host.disk` — `statvfs` on the host root (`/host-root`). Uses
  `Bavail` so reserved-for-root blocks are excluded from "free".
- `containers[]` — name / image / state / status / health (parsed from
  the Docker-formatted Status string).

## Sandbox

| Knob | Value |
| --- | --- |
| User | `65534:65534` (nobody) |
| `cap_drop` | ALL |
| `no_new_privileges` | true |
| `read_only` rootfs | true |
| `mem_limit` | 64m |
| Network exposure | docker default network only — never fronted by Caddy |

The Dockerfile uses the distroless static base, so there's no shell,
package manager, or busybox in the runtime image.

## Local

```bash
cd services/metrics-collector
go vet ./...
go test ./...
```

The host package's tests require a Linux `/proc` view; running on
macOS / Windows yields skip-marked failures (the production runtime is
Linux only).
