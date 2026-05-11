# Load testing

Tooling and runbook for stress-testing the production stack. Three k6
scenarios in `tests/load/`, plus seed + bake scripts in
`packages/db/src/` that pre-populate test users and pre-authed
cookies.

| Scenario | File | What it exercises |
| --- | --- | --- |
| Anonymous storefront | [anonymous-storefront.js](../tests/load/anonymous-storefront.js) | Caddy → web1/2/3 SSR → api catalog. Public surface only. |
| Authed storefront | [authed-storefront.js](../tests/load/authed-storefront.js) | Same + `/auth/me`, `/bets`, `/api/wallet`. Reads pre-baked cookies; bypasses the 5/min login rate limit. |
| WS subscribe | [ws-subscribe.js](../tests/load/ws-subscribe.js) | ws-gateway concurrent connection cap (default 5000) + odds-fanout throughput. |

Run them in stages: anonymous first to find the SSR ceiling without
auth complexity, authed second to add the per-request session cost,
ws-subscribe in parallel with one of the above to match realistic
traffic shape (every user keeps a WS open while browsing).

## Prerequisites

1. **k6 binary** on the box that drives the load. See "Where to launch
   from" below for capacity numbers.
2. **Test users** seeded into prod via the steps in the next section.
3. **Pre-baked cookies** (only for `authed-storefront.js`).

## Where to launch from

| Source | Realistic peak VUs | Why |
| --- | --- | --- |
| Home PC (Windows / macOS / Linux) | 500–1500 | Bottlenecked by home upload bandwidth and Windows TCP defaults. Fine for smoke-testing scripts. |
| Single DigitalOcean / Hetzner droplet (4 vCPU / 8 GB, ~€20/mo) | 5000–10000 | Plenty for the full 5000 target. Pro-rated cost is ~€0.03 / hour — destroy after the run. |
| k6 Cloud | 50000+ | Paid SaaS. Distributed across multiple regions. Overkill for the current target. |

**Yes — you can launch from your PC for smoke runs, but not for the
full 5000-VU test.** The killer isn't k6 itself (it can simulate
5000 VUs from a single laptop) — it's network. At 5000 concurrent
fresh page loads against `oddzilla.cc`, peak inbound bandwidth to your
PC is ~250 MB/s (each render returns ~50 KB), which is 2 Gbps —
nothing residential delivers that. From a cloud box with a Gbps NIC
on a tier-1 carrier, it's a non-issue.

### Recommended workflow

1. **Smoke from your PC** (`--vus 100 --duration 1m`) — confirms the
   scripts work, cookies are valid, paths return 2xx.
2. **Spin up a Hetzner CX22 in a different region** (so the test load
   doesn't compete with production traffic on the same egress) and run
   the full ramp from there.
3. **Tear down the droplet** once the run is done.

## k6 install

### Windows (PowerShell)

```powershell
winget install --id k6.k6
# or via Chocolatey:
choco install k6
# verify:
k6 version
```

### macOS

```sh
brew install k6
```

### Linux (Debian / Ubuntu)

```sh
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

### Docker (if you don't want a host install)

```sh
docker run --rm -i grafana/k6 run - <tests/load/anonymous-storefront.js
```

## Step 1 — Seed test users

Run from the prod box (the migrate script already uses `127.0.0.1:5432`
to reach the dockerized postgres). Bypasses the API; bulk-inserts in a
single transaction with `is_ai = true` so admin views + PnL aggregates
filter the rows out.

```sh
ssh team@178.104.174.24
set -a; . /home/team/oddzilla/.env; set +a
export DATABASE_URL=$(echo "$DATABASE_URL" | sed 's|@postgres:|@127.0.0.1:|')
COUNT=5000 pnpm --filter @oddzilla/db db:seed-loadtest
```

Expected output:

```
hashing shared password (argon2id m=19MiB t=2)...
  hashed in 127 ms
seeding 5000 loadtest users (batch=500)...
  5000/5000
done: +5000 users, +10000 wallets, +5000 signup-bonus ledger rows

--- credentials for k6 ---
  email pattern: loadtest+NNNN@oddzilla.test  (zero-padded, 0..4999)
  password:      loadtest-password-1
```

Idempotent — re-running adds only the missing rows.

## Step 2 — Bake cookies (authed test only)

POST `/auth/login` is rate-limited 5/min/IP, which kills any test
driving real logins from a single source. The bake script mints the
session row + signs JWTs directly:

```sh
ssh team@178.104.174.24 <<'EOF'
cd /home/team/oddzilla
set -a; . .env; set +a
export DATABASE_URL=$(echo "$DATABASE_URL" | sed 's|@postgres:|@127.0.0.1:|')
COUNT=5000 OUTPUT_FILE=/tmp/loadtest-cookies.json \
  pnpm --filter @oddzilla/db db:bake-loadtest-cookies
EOF
scp team@178.104.174.24:/tmp/loadtest-cookies.json tests/load/
ssh team@178.104.174.24 'rm /tmp/loadtest-cookies.json'
```

The output file is `[{ userId, email, access, refresh }, …]`. Each
access JWT has a 2-hour TTL by default (override with
`ACCESS_TTL_SECONDS=14400` for a 4-hour test).

**Keep `loadtest-cookies.json` out of git.** It contains valid JWTs
for 5000 sessions; treat it like a secret while the test is running.
The `.gitignore` excludes `tests/load/*.json` defensively.

## Step 3 — Run

### Smoke (every script) — 100 VUs for 30 s

```sh
k6 run -e BASE_URL=https://oddzilla.cc --vus 100 --duration 30s \
  tests/load/anonymous-storefront.js
```

Expect `http_req_failed < 0.5%` and `p(95) < 1500 ms`. If that's not
the case, the scripts or env vars are wrong before the system is.

### Full ramp — anonymous storefront, 5000 VUs

```sh
k6 run -e BASE_URL=https://oddzilla.cc tests/load/anonymous-storefront.js
```

Default ramp: 0 → 5000 VUs over 180 s, hold 180 s, ramp down 60 s.
Override with `PEAK_VUS`, `RAMP_S`, `HOLD_S`, `RAMP_DOWN_S`.

### Authed storefront

```sh
k6 run -e BASE_URL=https://oddzilla.cc \
  -e COOKIES_PATH=tests/load/loadtest-cookies.json \
  tests/load/authed-storefront.js
```

### WS subscribe (parallel)

In a second terminal, while one of the storefront scripts is running:

```sh
k6 run -e WS_URL=wss://oddzilla.cc/ws \
  -e PEAK_VUS=5000 -e HOLD_S=300 \
  tests/load/ws-subscribe.js
```

ws-gateway's `WS_MAX_CLIENTS` cap is 5000 (see
[services/ws-gateway/src/server.ts](../services/ws-gateway/src/server.ts)).
The script will see 503s if you exceed that — that's the gateway
doing exactly what it's designed to do.

## Step 4 — Watch the box while it runs

Three terminals on the production box:

```sh
# 1. Live host + container metrics — same numbers /admin/monitoring shows
ssh team@178.104.174.24 'watch -n 2 "sudo -n docker stats --no-stream"'

# 2. Web replica logs (interleaved)
ssh team@178.104.174.24 'cd /home/team/oddzilla && make weblogs'

# 3. API error stream
ssh team@178.104.174.24 'cd /home/team/oddzilla && \
  sudo -n docker compose logs -f --tail=200 api | \
  jq -c "select(.level >= 40 or .res.statusCode >= 500)"'
```

Watch:

- **CPU** — postgres + the three web replicas climbing first. If postgres
  pegs to 1.5 CPU (its cap), throughput is DB-bound.
- **Memory** — total committed should stay under 6 GB. The 8 GB box has
  ~6 GB of `mem_limit` sum; OS overhead eats the rest.
- **Container health** — anything dropping to `unhealthy` or restarting
  is the signal that one replica's been pushed past its budget. Caddy
  drops it from the upstream group within 5 s.
- **HTTP error rate** — k6's summary reports `http_req_failed`. Anything
  over 2% on the storefront paths means we found a ceiling.

## Step 5 — Find a slow request and trace it

After the run, pick the slowest p99 request from k6's summary and:

1. Find the matching x-request-id in the k6 log (the authed script
   stamps `loadtest-vu<N>-it<M>` per iteration).
2. Grep across web + api + ws-gateway logs:

```sh
ssh team@178.104.174.24 'cd /home/team/oddzilla && \
  sudo -n docker compose logs --since=10m api web1 web2 web3 ws-gateway | \
  jq -c "select(.reqId == \"loadtest-vu1234-it5\" or .requestId == \"loadtest-vu1234-it5\")"'
```

You see the SSR replica that handled the request, the api log line for
every fetch it made, and any ws-gateway upgrade that landed on the same
session — all stitched by request id.

## Step 6 — Cleanup

```sh
ssh team@178.104.174.24 <<'EOF'
cd /home/team/oddzilla
set -a; . .env; set +a
export DATABASE_URL=$(echo "$DATABASE_URL" | sed 's|@postgres:|@127.0.0.1:|')
pnpm --filter @oddzilla/db db:seed-loadtest:cleanup
EOF
rm tests/load/loadtest-cookies.json
```

The cleanup script deletes in dependency order (sessions → wallet_ledger
→ wallets → tickets → users) and reports per-table counts. Achievement
unlocks + community projection rows for the loadtest users are also
swept.

## Expected results (rough)

Before this is run for real these are educated guesses; update with
actual numbers after the first ramp.

| Metric | Anonymous storefront | Authed storefront | WS subscribe |
| --- | --- | --- | --- |
| Peak sustainable VUs (CPX31, 3 web replicas) | ~3000–4000 | ~2000–2500 | ~5000 (capped) |
| p95 SSR latency at peak | < 2 s | < 3 s | n/a |
| First bottleneck to fall | Next.js SSR queue | Same + `/auth/me` Redis cache | ws-gateway memory |

Refine after the first real run. The whole point of running it is to
turn these guesses into measurements.
