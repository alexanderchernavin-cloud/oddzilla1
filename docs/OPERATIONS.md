# Operations

Deploy, backup, observability, and incident response for the Hetzner CPX31
deployment (4 vCPU / 8 GB / 160 GB; upgraded from CPX22 on 2026-05-11 to
support the Next.js SSR replica fan-out). Access is SSH key-based as
`team@178.104.174.24`.

## Server state (current)

The server at `team@178.104.174.24` is **already provisioned** and
running the production stack:

- Ubuntu 24.04 LTS, Docker 29, Docker Compose v5, Node 22, pnpm 9.12,
  `git`, `make`, `unzip` installed
- `team` user is in `docker` and `sudo` groups (use `sg docker -c '…'`
  in scripts that ssh fresh, or just rely on the implicit group on
  interactive sessions)
- Repo clone at `/home/team/oddzilla`, tracking
  `https://github.com/alexanderchernavin-cloud/oddzilla1` `main`
- `.env` at `/home/team/oddzilla/.env` (mode 600) with real secrets;
  `ODDIN_CUSTOMER_ID=142` from `GET /v1/users/whoami`
- Full Compose stack live: postgres, redis, caddy, api, web, ws-gateway,
  feed-ingester, odds-publisher, settlement, bet-delay, wallet-watcher
- Connected to Oddin integration broker (bookmaker 142) via AMQPS on
  port 5672
- DNS: `FRONTEND_HOST=oddzilla.cc` (apex), `ADMIN_HOST=sadmin.oddzilla.cc`
  (registered at Porkbun). A records on both point to `178.104.174.24`.
  The legacy `s.oddzilla.cc` A record stays in DNS so Caddy's hard-coded
  301 block (`s.oddzilla.cc → oddzilla.cc`) keeps working — drop both
  the DNS record and the Caddy block once the legacy subdomain stops
  receiving traffic. Caddy auto-provisions Let's Encrypt certs on first
  hit for every configured host.

## First-time server setup (reference, only if rebuilding)

```bash
ssh team@178.104.174.24
git clone https://github.com/alexanderchernavin-cloud/oddzilla1 ~/oddzilla
cd ~/oddzilla
bash infra/hetzner/bootstrap.sh      # UFW, Docker, swap, team in docker group
sudo usermod -aG docker team          # if bootstrap missed it; then re-ssh
cp .env.example .env
$EDITOR .env                          # fill real secrets, set ODDIN_CUSTOMER_ID via /v1/users/whoami
# Build services SERIALLY — `docker compose build` (no service arg)
# parallel-builds 7 services and OOMs the 4 GB CPX22 (see
# project_build_oom_incident; took the site down ~30 min on 2026-05-06).
for svc in postgres redis caddy api web1 ws-gateway feed-ingester odds-publisher settlement bet-delay wallet-watcher; do
  sudo -n docker compose -f docker-compose.yml --profile scaled build $svc
done
sudo -n docker compose -f docker-compose.yml --profile scaled up -d
pnpm install --frozen-lockfile=false
PGUSER=$(grep ^POSTGRES_USER= .env | cut -d= -f2) \
  PGPASS=$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2) \
  PGDB=$(grep ^POSTGRES_DB= .env | cut -d= -f2) \
  DATABASE_URL="postgres://${PGUSER}:${PGPASS}@127.0.0.1:5432/${PGDB}?sslmode=disable" \
  pnpm --filter @oddzilla/db db:migrate
# pnpm --filter @oddzilla/db db:seed   # optional: 4 sports + admin/test users
```

Production omits the `docker-compose.override.yml` (which is dev-only —
mounts source for hot reload) by passing `-f docker-compose.yml`
explicitly.

## Daily deploy

```bash
ssh team@178.104.174.24 "cd /home/team/oddzilla && make deploy"
```

That's the whole deploy. The target wraps
[`infra/deploy/deploy.sh`](../infra/deploy/deploy.sh), which does:

1. `flock` `/var/lock/oddzilla-deploy.lock` so two operators can't deploy at once.
2. `git fetch origin main`.
3. Compute the file diff between the last-deployed SHA (stored at
   `.deploy/last-sha`) and `origin/main`.
4. Map changed files → affected services via
   [`infra/deploy/detect-services.sh`](../infra/deploy/detect-services.sh).
   **This runs from the checkout as it is BEFORE the fast-forward**, so the
   deploy that first adds a compose service uses a `detect-services.sh` that
   has never heard of it: the new container is neither built nor created,
   even though every sibling is rebuilt (support-ai-bot 2026-09-01,
   bifrost-feed 2026-09-03). After such a deploy finishes, run
   `make build SVC=<new> && make recreate SVC=<new>` once; from the next
   deploy on the script knows the service.
5. `git reset --hard origin/main`.
6. If the diff includes any `packages/db/migrations/*.sql`: take a pre-deploy
   `pg_dump` to `.deploy/backups/<sha>.sql.gz` (keep only the most recent —
   `PRE_DEPLOY_BACKUP_RETENTION`, default 1 since 2026-07-02; dumps are
   ~8.3 GB each now, and two retained plus one in-flight nearly filled
   the 150 GB box mid-deploy).
7. Apply migrations via `pnpm --filter @oddzilla/db db:migrate` with the
   `DATABASE_URL` rewritten from `@postgres:` to `@127.0.0.1:` for host-side
   resolution.
8. **Parallel-build** the changed services via `docker compose build` with all
   service names in one invocation. If a future regression OOMs again (it has
   not since the CPX31 upgrade), set `DEPLOY_BUILD_PARALLEL_CAP=2` (maps to
   `COMPOSE_PARALLEL_LIMIT`) and re-run.
9. Tag each built image with the deploying SHA via
   [`infra/deploy/tag-images.sh`](../infra/deploy/tag-images.sh) — and prune
   anything beyond the most-recent 3 SHAs so disk usage stays bounded.
10. `docker compose up -d --no-deps --force-recreate` the non-web services.
11. `make recreate-web` rolls `web1 → web2 → web3` serially, waiting for each
    healthcheck before the next.
12. If `Caddyfile` changed: `caddy reload` inside the running container (no
    rebuild needed — caddy is an upstream image).
13. Write the new SHA to `.deploy/last-sha` and log the event to `.deploy/log`.
14. Run the smoke test: 4 endpoints across web SSR + api via Caddy, plus a
    `401` check on `/api/auth/me` to catch auth-plugin breakage.

Dry-run + rollback:

```bash
make deploy-status   # show commits + services + migrations, no side effects
make rollback        # retag previous SHA → :latest + recreate touched services
```

What rollback does NOT do:

- Revert migrations. Convention is forward-only nullable-additive, so the
  previous code reads the newer schema cleanly. If a migration was
  destructive, restore from `.deploy/backups/<sha>.sql.gz` manually before
  rollback.
- Move the git worktree. Source stays at the failed-deploy SHA. Run
  `git -C /home/team/oddzilla reset --hard <previous-sha>` after the rollback
  if you want code to match the containers.

What can still go wrong, and the failure mode:

| Failure | Effect on state |
| --- | --- |
| `git fetch` fails | Nothing recreated, `last-sha` unchanged, safe to retry. |
| `pg_dump` fails before migrate | Migration NOT applied, deploy halts, `last-sha` unchanged. |
| `db:migrate` fails | Containers not yet recreated. Pre-deploy snapshot exists at `.deploy/backups/<sha>.sql.gz`. Fix forward (write a corrective migration) or restore. |
| `docker compose build` fails | No image tagged, no recreate, `last-sha` unchanged. Investigate the build log. |
| `force-recreate` fails for one service | Earlier services already recreated on the new image; `last-sha` not yet updated. Resolve and re-run — `make deploy` is idempotent against partial state because Compose treats an already-current container as a no-op. |
| Smoke fails | `last-sha` IS updated (containers are running the new code) and `smoke_fail` is appended to the log. Either `make rollback` or fix forward. |

> **Never run `docker compose build` or `pnpm db:migrate` by hand on the
> box** unless you have a reason that doesn't fit `make deploy`. The script
> is the only place where build → recreate ordering, image tagging, and the
> deploy log stay coherent.

> **Never recreate all three web replicas in parallel.** A flat
> `docker compose up -d --force-recreate web1 web2 web3` takes them down
> together and surfaces a ~10 s 502 wall to users. `make recreate-web` (used
> internally by `make deploy`) cycles them serially.

> **Never recreate only `web1` when the scaled profile is up.** A `docker
> compose up -d --force-recreate web1` leaves `web2` and `web3` running on
> the previous image; Caddy's `lb_policy least_conn` distributes across all
> three, so users see a ~2/3 chance of stale HTML per request. `make deploy`
> always goes through `recreate-web` for any web-touching deploy.

State the deploy keeps under `/home/team/oddzilla/.deploy/`:

```
.deploy/
├── last-sha            # marker of the last successful deploy
├── log                 # newline-delimited event log (deploy / rollback / smoke_fail)
├── images/             # one file per service, stack of recent SHAs (most-recent-first)
│   ├── api
│   ├── web1
│   └── feed-ingester
└── backups/            # pre-deploy pg_dumps (only when migrations shipped)
    ├── 0cb113d…sql.gz
    └── …
```

For tighter loops, GitHub Actions can ssh + run `make deploy` on merge to
`main` (workflow at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
— not yet added; add when the deploy cadence justifies the extra moving
piece).

## Environment variables

Full list with docs is in [`.env.example`](../.env.example). Summary of
what's sensitive:

| Key | Source | Rotation |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | generated at bootstrap | rare — requires DB down+up |
| `JWT_SECRET` | `openssl rand -base64 48` | every 6 months; old tokens invalidate |
| `REFRESH_COOKIE_SECRET` | `openssl rand -base64 48` | every 6 months |
| `ODDIN_TOKEN` | from Oddin | when Oddin rotates (~1 yr) |
| `ODDIN_CUSTOMER_ID` | `GET /v1/users/whoami` with the token (`/users/whoami` returns 404 — the legacy path is gone) | only when Oddin reissues |
| `ODDIN_AMQP_PORT` | always **5672** for both integration and production (Oddin runs AMQPS on the plain-AMQP port; 5671 is closed) | n/a |
| `HD_MASTER_MNEMONIC` | BIP39 12/24-word phrase | **read only by the [signer container](../services/signer/), not the API**. Rotating is a customer-facing event (every deposit address changes). |
| `SIGNER_SOCKET_PATH` (default `/run/signer/signer.sock`) | tmpfs volume mount path | n/a |
| `TRON_RPC_URL` | TronGrid (mainnet `https://api.trongrid.io`, testnet `https://api.shasta.trongrid.io`) | when plan changes |
| `ETH_RPC_URL` | Alchemy / Infura / QuickNode / self-hosted | when plan changes |
| `BACKUP_GPG_RECIPIENT` (optional, PR #130) | GPG key id of an off-host operator. Set → daily pg dump is GPG-encrypted (`.sql.gz.gpg`); unset → plain gzip. | rotate when the operator's key rotates |
| `SUPPORT_AI_BOT_TOKEN` (optional) | `openssl rand -hex 24`. Auth for `/webhooks/support-ai/*`. The SAME value goes in the PC worker's own `.env`. | any time — rotate both sides together |
| `BANNER_GEN_TOKEN` (optional, migration 0089) | `openssl rand -hex 24`. Auth for `/webhooks/banner-gen/*` (ZillaBoost image worker). The SAME value goes in `services/zillaboost-banner-gen/.env` on the operator PC. | any time — rotate both sides together |

Each service can boot WITHOUT certain optional vars and degrades
gracefully:

| Service | Required | Optional → effect when absent |
| --- | --- | --- |
| api | DATABASE_URL, REDIS_URL, JWT_SECRET, REFRESH_COOKIE_SECRET, SIGNER_SOCKET_PATH | signer unreachable → `/wallet/deposit-addresses` returns 500 with `SignerUnavailableError`. FIREBASE_SERVICE_ACCOUNT_PATH unset OR target file missing → push-outbox worker still drains the queue but marks every row `sent_at=NOW(), last_error='firebase_disabled'`; no FCM notifications go out until credentials are mounted. EMAIL_PROVIDER_TOKEN unset → email-outbox worker still drains but stamps each row `last_error='email_disabled'`; signup verify + forgot-password emails are queued and discarded until a key is set. SENDGRID_INBOUND_SECRET unset → `/webhooks/sendgrid-inbound/*` 503s `inbound_disabled` (no inbound mail can be ingested). SUPPORT_AI_BOT_TOKEN unset → `/webhooks/support-ai/*` 503s `bot_disabled`, support chat falls back to humans. BANNER_GEN_TOKEN unset → `/webhooks/banner-gen/*` 503s `banner_gen_disabled`; ZillaBoost graphics jobs still enqueue and wait in `zillaboost_banner_image_jobs` until a token exists. |
| mail-receiver | SENDGRID_INBOUND_SECRET, MAIL_WEBHOOK_URL | Container fails to boot if either is unset — fail-fast so the operator notices immediately rather than discovering mail is silently lost. Outbound is unaffected (Resend, separate path). |
| signer | HD_MASTER_MNEMONIC | n/a — only this service reads the mnemonic |
| feed-ingester | DATABASE_URL, REDIS_URL | ODDIN_TOKEN+ODDIN_CUSTOMER_ID absent → idle, health-only |
| settlement | DATABASE_URL, REDIS_URL | ODDIN_TOKEN+ODDIN_CUSTOMER_ID absent → idle, health-only |
| odds-publisher | DATABASE_URL, REDIS_URL | none — runs as soon as redis stream `odds.raw` has entries |
| bet-delay | DATABASE_URL, REDIS_URL | none |
| wallet-watcher | DATABASE_URL | TRON_RPC_URL absent → TRC20 scanner disabled. ETH_RPC_URL absent → ERC20 scanner disabled. Both absent → idle, health-only |
| ws-gateway | REDIS_URL, JWT_SECRET | none |
| support-ai-bot, zillaboost-banner-gen | ODDZILLA_API_BASE + their token | **Not compose services** — both run on an operator PC and dial OUT (see [support-ai-bot](../services/support-ai-bot/README.md) / [zillaboost-banner-gen](../services/zillaboost-banner-gen/README.md)). Missing env → the worker parks health-only instead of crash-looping. Not running at all → the server-side queue simply accumulates. |

Keep `.env` out of git. Consider `sops + age` or a secrets manager before
public launch.

## Health and observability

### Health endpoints

Each service exposes `/healthz` that pings its dependencies. In **prod**
the host loopback ports are not bound (Caddy reaches upstreams via the
compose DNS network), so health checks run via `docker compose exec`:

```bash
sudo -n docker compose exec api          wget -qO- http://127.0.0.1:3001/healthz
sudo -n docker compose exec ws-gateway   wget -qO- http://127.0.0.1:3002/healthz
sudo -n docker compose exec feed-ingester wget -qO- http://127.0.0.1:8081/healthz
# … same pattern for odds-publisher (8082), settlement (8083),
#   bet-delay (8084), wallet-watcher (8085).
for r in web1 web2 web3; do
  sudo -n docker compose exec $r        wget -qO- http://127.0.0.1:3000/healthz
done
```

In **dev** (`-f docker-compose.yml -f docker-compose.dev.yml`) the same
ports are also published on `127.0.0.1` of the host for direct
`curl localhost:3001/healthz` access.

Docker Compose healthchecks poll these endpoints inside the container;
unhealthy containers restart.

### Logs

All services emit structured JSON (`pino` / `zerolog`).

```bash
make logs                              # tail all
make weblogs                           # interleaved tail of web1/web2/web3
docker compose logs -f api             # single service
docker compose logs --since=1h feed-ingester | jq 'select(.level=="error")'
```

**Tracing a request across the stack.** Every page render generates (or
echoes inbound) an `x-request-id` header in the Next.js middleware. The
ID is forwarded on every server-side fetch to the api, picked up by
Fastify's `genReqId`, and echoed back to the browser on the response
header. To follow one user's session:

```bash
# Find their request id from the browser dev-tools network tab, or ask
# them to copy/paste the x-request-id from a stuck response. Then:
docker compose logs --since=15m api web1 web2 web3 ws-gateway | \
  jq -c "select(.reqId == \"$REQ\" or .requestId == \"$REQ\")"
```

The request id is the only field guaranteed to correlate web SSR → api
→ ws-gateway hops. `reqId` is Fastify's auto-injected field name on api
log lines; `requestId` is the same value emitted by the Next.js
middleware + server-fetch logging — the jq predicate above accepts
both.

### Metrics (Phase 4+)

Add Prometheus + Grafana once Phase 4 goes live. Key metrics to watch:

- `feed_ingester_amqp_messages_total{type}` — message rate by type
- `feed_ingester_recovery_triggered_total` — should be low in steady state
- `odds_publisher_publish_latency_ms` — p95 < 100 ms
- `settlement_apply_latency_ms` — p95 < 500 ms
- `settlement_replay_total` — counts duplicate messages (informational)
- `wallet_watcher_confirmations_lag` — blocks behind chain head
- `api_http_request_duration_ms{route,status}` — standard
- `postgres_connections_active`, `postgres_replication_lag_bytes` (once
  replica exists)

### Wallet reconciliation (Phase 7 exit criterion)

Daily cron job (`services/api` or a dedicated `services/reconciler`).
Reconciliation is per-currency since migration 0014:

```sql
SELECT w.currency,
       SUM(w.balance_micro)                          AS balance_total,
       COALESCE(l.ledger_total, 0)                   AS ledger_total,
       SUM(w.balance_micro) - COALESCE(l.ledger_total, 0) AS drift_micro
  FROM wallets w
  LEFT JOIN (
    SELECT currency, SUM(delta_micro) AS ledger_total
      FROM wallet_ledger
     GROUP BY currency
  ) l USING (currency)
 GROUP BY w.currency, l.ledger_total;
```

Drift must be zero per currency. Any non-zero value pages on-call.
Note that the OZ row will read `balance = signup_bonus_count × 1_000_000_000`
matching `ledger = same` — it nets to zero like USDT does.

## Backups

The daily dump is wired up via root cron at 03:00 UTC, running
[`infra/hetzner/backup/pg_backup.sh`](../infra/hetzner/backup/pg_backup.sh).
The script `docker exec`s into the postgres container and writes
`/var/backups/oddzilla/oddzilla-<TS>.sql.gz` (root:team mode 640).
Retention is **count-based** — keep the newest `RETENTION_COUNT` dumps
(script default **2**; the production cron line pins `RETENTION_COUNT=1`
since 2026-08-26, when the off-host pull below went live — the durable
history line is the workstation copy, the on-box dump only has to survive
until the next pull). At ~5.5 GB/dump (the dump
size tracks the DB; see odds_history retention below) two dumps hard-bound
the local footprint to ~11 GB. The script prunes to `RETENTION_COUNT-1`
**before** dumping and writes to a `.part` temp with an atomic rename, so a
full disk can neither block rotation (the 2026-06-09 death-spiral) nor leave
a truncated dump masquerading as valid. Set `BACKUP_GPG_RECIPIENT` in `.env`
to GPG-encrypt the dump in addition to gzipping; the extension becomes
`.sql.gz.gpg`. Older history lives off-host (pull-to-workstation, below).

Watch the **pre-deploy dumps** after a failed deploy: `make deploy`
writes its dump BEFORE building, and a deploy that dies mid-build
leaves that ~8 GB dump stranded in `.deploy/backups/` next to the
previous one. Two failed attempts back-to-back filled the disk to 100%
on 2026-08-26 and crash-looped postgres for ~40 s (WAL redo recovered
cleanly). After any failed deploy, prune the stranded dump before
retrying.

### odds_history retention

`odds_history` is `PARTITION BY RANGE (ts)` (migrations 0000 + 0001), but
the intended partition maintenance never ran: **pg_partman was never
installed** in the postgres image, and the "Phase 3" cron that the 0001
fallback comment promised (pre-create upcoming partitions, drop old ones)
**was never built**. So from launch (2026-04-18) every row landed in the
catch-all `odds_history_default` partition and nothing pruned it — by
2026-06-17 it was 64 GB / 560 M rows, growing ~1 GB/day. This is the root
cause of the repeat disk-full outages (2026-04-22, 05-09, 06-09, 06-17);
trimming backups only ever delayed an unbounded table.

**Since 2026-08-26 the table runs on daily dated partitions**
(`odds_history_pYYYYMMDD`, UTC-midnight bounds) plus a safety DEFAULT
(`odds_history_default3`, expected empty).
[`infra/hetzner/backup/odds_retention.sh`](../infra/hetzner/backup/odds_retention.sh)
(installed as `oddzilla-odds-retention`, cron `30 3 * * *`) now does
partition maintenance instead of DELETEs: pre-creates partitions
`today..today+ODDS_CREATE_AHEAD` (default 7), DETACH CONCURRENTLY + DROPs
dated partitions older than `ODDS_RETENTION_DAYS` (default **35**; admin
odds charts look back 30 days, ZillaTips reads the permanent
`prematch_odds` snapshot, settlement never reads history), and sweeps the
safety DEFAULT with a small batched DELETE (a non-trivial row count there
is logged as a warning — it means inserts are falling outside every dated
partition). A partition DROP is instant and returns space to the OS, so
the table carries **zero bloat and no high-water mark** — the disk cost is
exactly the live window (~35 GB at current volume) plus the day being
written.

The pre-2026-08-26 model was a nightly batched DELETE against a single
catch-all DEFAULT partition: it plateaued the heap (~60 GB at the 45-day
window) but never returned pages to the OS — the reason both one-time
reclaims below were needed.

#### One-time reclaim (when you want the ~50 GB back)

> **Executed 2026-07-02.** Adapted for low free disk (16 GB — not enough
> to hold old + new copies of the full 45-day window): swapped in
> `odds_history_default2` as the new DEFAULT partition (with the same
> aggressive autovacuum reloptions), backfilled the **9 most recent days**
> (~72.2M rows, row-count-verified against the source) newest-first with a
> 6 GB free-disk guard, then dropped the old 68 GB default. Disk went
> 95% → 50% (73 GB free). The table regrows ~1 GB/day back to its 45-day
> plateau (~45 GB) over the following 5 weeks — steady state ≈ 65% used.
> History older than 2026-06-24 exists only in the nightly dumps from
> before the reclaim. The nightly DELETE cron continues to work unchanged
> (it targets the parent table).

> **Second reclaim + dated-partition conversion executed 2026-08-26.**
> Window narrowed 45 -> 35 days. Disk couldn't hold old + new copies
> side-by-side, so the swap ran as export -> drop -> restore: (1) one tx
> DETACHed `odds_history_default2` and created daily partitions
> `2026-07-23..2026-09-02` plus safety DEFAULT `odds_history_default3` —
> inserts rerouted instantly, zero loss; (2) the 35-day keep-window
> (~380 M rows) was exported from the detached table in one seq scan to
> line-aligned gzip chunks (~5 GB), row-count-verified; (3) the 60 GB old
> heap was DROPped (disk 90% -> 55%); (4) chunks were restored through the
> parent into the dated partitions with CHECKPOINTs between. The retention
> cron was rewritten to the partition model in the same change (see above)
> — no third reclaim will ever be needed.

> **Incident during the conversion (same evening):** the first cut of
> the partition-drop cron extracted the partition date with a
> positional substring carrying an off-by-one prefix length — every
> partition compared below the cutoff and a test run dropped ALL 42
> dated partitions, freshly restored history included. Recovered from
> the pre-swap full deploy dump (`.deploy/backups/`); permanent loss
> was only the ~85 min of odds ticks between that dump's snapshot and
> the moment the safety DEFAULT started catching inserts (18:30–19:55
> UTC — chart/audit data only; money paths never read odds_history).
> Two guards now sit in the script: the date is extracted with an
> anchored regex capture (`p([0-9]{8})$`), and a fuse refuses to drop
> more than `ODDS_RETENTION_MAX_DROPS` (default 10) partitions in one
> run — a healthy night drops exactly one, so a longer list means the
> selection itself is broken and the script aborts + pages instead.

A plain DELETE + `VACUUM` won't return disk; `VACUUM FULL` needs ~table-size
temp and an `ACCESS EXCLUSIVE` lock (odds writes freeze for minutes), and
`pg_repack` isn't in the image. The cheap, lock-light path exploits the
partitioning — a partition DROP is instant and returns space immediately:

```sql
BEGIN;                                          -- brief lock; inserts wait a few seconds
ALTER TABLE odds_history DETACH PARTITION odds_history_default;
-- create go-forward dated partitions covering now + a few days, e.g. daily:
CREATE TABLE odds_history_p20260617 PARTITION OF odds_history
  FOR VALUES FROM ('2026-06-17') TO ('2026-06-18');
-- … repeat for the next several days …
CREATE TABLE odds_history_default2 PARTITION OF odds_history DEFAULT;
COMMIT;
-- backfill the keep-window in DAILY batches with CHECKPOINT between each so
-- WAL stays bounded (skip entirely if a few sparse days of admin charts is OK):
INSERT INTO odds_history SELECT * FROM odds_history_default
  WHERE ts >= '2026-06-10' AND ts < '2026-06-11';   -- one day; CHECKPOINT; repeat
DROP TABLE odds_history_default;                 -- instant; frees the old heap
```

This also converts retention to the clean partition-drop model going forward
(drop the oldest dated partition each night instead of DELETE — no bloat, no
VACUUM ever). It's destructive (drops history beyond the keep-window, though
it's in the daily dump) and has a few-second write pause, so do it deliberately
with a fresh backup in hand — it is **not** wired into the nightly cron.

Hardening applied in PR #130: the script no longer sources the entire
`.env` into the cron shell environment (every secret was being exported
into the cron PID's `/proc/<pid>/environ`); it now reads only
`POSTGRES_USER`, `POSTGRES_DB`, and `BACKUP_GPG_RECIPIENT`. Since
2026-09-03 the password is not read on the host at all: `pg_dump` runs
through `docker exec <container> sh -c 'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_dump …' sh <user> <db>`,
taking it from the postgres container's own environment. The earlier
`docker exec -e PGPASSWORD=<value>` form exposed the real password in
`ps` to every local user for the duration of each run (and, for the
`sudo`-wrapped pre-deploy dump, in the sudo journal line); it was spotted
in a process listing during a deploy. The same pattern is used by the
pre-deploy `infra/deploy/dump-db.sh`, `audit_chain_check.sh`,
`odds_retention.sh` and `settlements_retention.sh`. After changing any
of the cron scripts, re-copy them to `/usr/local/bin/oddzilla-*` — cron
runs the installed copies, not the repo checkout.

### settlements retention

`settlements` (the apply-once log behind CLAUDE.md invariant #3) was the
next unbounded table after odds_history: 9.8 GB / 12.05M rows on 2026-07-02,
growing ~90–110 MB/day. Measured breakdown: 6.2 GB heap — of which 4.3 GB is
`payload_json` (avg 371 B/row, all inline, no TOAST) — plus 3.6 GB of
indexes (the 5-tuple dedup unique alone is 2.2 GB).

[`infra/hetzner/backup/settlements_retention.sh`](../infra/hetzner/backup/settlements_retention.sh)
(installed as `oddzilla-settlements-retention`, cron `45 3 * * *`) deletes
`settle` / `cancel` rows older than `SETTLEMENTS_RETENTION_DAYS` (default
**45** — operator decision 2026-07-03, same window as odds_history) in
bounded batches, with two guards:

- the market must have no open (`pending_delay` / `accepted`) ticket —
  covers combos with one leg settled and another on a far-future match;
- `rollback_settle` / `rollback_cancel` rows are never deleted (~300 rows
  total; a re-applied rollback is the one replay class that would claw
  back a real payout, so those dedup rows are kept forever for free).

The durable record of every bet does NOT live here: `tickets`,
`ticket_selections`, `wallet_ledger`, and `market_outcomes.result` are
never deleted by anything — this cron only prunes the raw Oddin message
journal on top of that. Neither recovery-flush path deletes `markets`
(both auto and admin `flushOdds=true` are SUSPEND-only), so pruning
settlements rows cannot expose the markets/outcomes they referenced.

Why deleting dedup rows is safe: the unique key only rejects
**byte-identical** replays — a genuine late re-settlement from Oddin carries
a different `payload_hash` and is supposed to apply. Identical replays have
two systematic sources, both bounded to ~1 day (AMQP redelivery, and feed
recovery which `RecoveryWindowCap` clamps to now-24 h — snapshot recovery
carries odds state, not settlement messages). Even a hypothetical
months-late identical replay is money-safe: `maybeSettleTicket` skips every
non-`accepted` ticket, terminal market status is sticky, outcome-result
rewrites are idempotent, and `wallet_ledger`'s unique
`(type, ref_type, ref_id)` index blocks residual double-credits
(invariant #4). 45 days is therefore ~45× margin over the real window.

Same plateau caveat as odds_history: a DELETE never returns pages to the
OS — with the install-time autovacuum reloptions the heap stabilises at
~45 d × ~111 MB/day ≈ **5 GB** of live data inside the existing ~10 GB
high-water footprint (the rest is reusable free space; a one-time reclaim
is not worth it for this table). The first run deletes the ~6M-row
backlog older than 45 days; after that it's ~135K rows/night.

### Off-server copy — pull to operator workstation

[`infra/local/pull-backup.ps1`](../infra/local/pull-backup.ps1) is a
PowerShell script that runs on the operator's PC and `scp`s every dump
not already present locally. Schedule via Windows Task Scheduler:

```text
Program:    powershell.exe
Arguments:  -ExecutionPolicy Bypass -NoProfile -File "D:\path\to\pull-backup.ps1"
            -RemoteHost team@178.104.174.24 -DestDir D:\backups\oddzilla
Trigger:    Daily, 04:00 local (one hour after the server-side cron at 03:00 UTC).
```

Pre-condition: the server-side dir + dumps must be readable by the
`team` group. After deploying the updated `pg_backup.sh`, one-shot fix
existing files:

```bash
ssh team@178.104.174.24 "sudo chgrp -R team /var/backups/oddzilla && \
  sudo chmod 750 /var/backups/oddzilla && \
  sudo chmod 640 /var/backups/oddzilla/*.sql.gz*"
```

New dumps inherit those modes from the script.

### Disk-fill alert (email)

[`infra/hetzner/backup/disk_fill_alert.sh`](../infra/hetzner/backup/disk_fill_alert.sh)
emails the operator when the root filesystem crosses
`DISK_FILL_THRESHOLD_PCT` (default 80%), paging through the shared
[`oddzilla-alert-email`](../infra/hetzner/backup/alert_email.sh) helper
(Resend HTTP API, `EMAIL_PROVIDER_TOKEN` + `ALERT_EMAIL_TO` from `.env`).
The email includes the largest dirs under `/` for fast triage. Install:

```bash
ssh team@178.104.174.24
sudo cp /home/team/oddzilla/infra/hetzner/backup/alert_email.sh \
  /usr/local/bin/oddzilla-alert-email
sudo cp /home/team/oddzilla/infra/hetzner/backup/disk_fill_alert.sh \
  /usr/local/bin/oddzilla-disk-fill-alert
sudo chmod 755 /usr/local/bin/oddzilla-alert-email
sudo chmod 750 /usr/local/bin/oddzilla-disk-fill-alert

# Append to root's crontab — every 15 minutes:
sudo crontab -e
# */15 * * * * /usr/local/bin/oddzilla-disk-fill-alert >> /var/log/oddzilla-disk-fill-alert.log 2>&1
```

Without `EMAIL_PROVIDER_TOKEN` + `ALERT_EMAIL_TO` the helper logs a single
JSON line to journal and exits 0 — the watchdog still runs and records every
check, it just can't page. (An earlier version posted to `SLACK_WEBHOOK_URL`;
the box switched to email on 2026-06-09.) Confirm the channel actually reaches
you with a test page — `sudo /usr/local/bin/oddzilla-alert-email "test" "body"`
— so a real fill isn't the first time you learn it's misrouted.

The 2026-04-22 → 2026-04-28 disk-full incident
(`project_disk_full_incident` memory) ran for 6 days before anyone
noticed because postgres was the only loud signal and the
`docker_prune.sh` mitigation is passive. This is the active page — but
note it only fires once the disk is *already* near full. The structural
guard against a slow fill is the odds_history retention above; the watchdog
is the backstop. On 2026-06-17 the box hit 100% while sitting just under the
80% threshold for days as odds_history crept up — the threshold caught the
final spike, not the creep, which is why capping the table matters more than
tuning the alert.

### Audit-log integrity probe

The `admin_audit_log` table has a SHA-256 hash chain (PR #130). To
verify no row has been tampered with after insert:

```sh
ssh team@178.104.174.24 'set -a; . /home/team/oddzilla/.env; set +a; \
  sudo -n docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" -c "SELECT COUNT(*) FILTER (WHERE ok) AS valid, \
  COUNT(*) FILTER (WHERE NOT ok) AS broken, COUNT(*) AS total \
  FROM admin_audit_chain_check();"'
```

`broken` should always be `0`. Non-zero is the canonical signal that
someone modified an audit row via direct DB access (the API path goes
through the trigger and stays consistent).

### Audit-log integrity check (automated daily)

The probe above is manual. [`infra/hetzner/backup/audit_chain_check.sh`](../infra/hetzner/backup/audit_chain_check.sh)
runs it on a schedule and Slack-pages if any row fails the chain, so the
tamper-evidence isn't dormant until someone remembers to check. Install:

```bash
ssh team@178.104.174.24
sudo cp /home/team/oddzilla/infra/hetzner/backup/audit_chain_check.sh \
  /usr/local/bin/oddzilla-audit-chain-check
sudo chmod 750 /usr/local/bin/oddzilla-audit-chain-check

# Append to root's crontab — daily 04:00 UTC (just after the 03:00 pg dump):
sudo crontab -e
# 0 4 * * * /usr/local/bin/oddzilla-audit-chain-check
```

Reuses `SLACK_WEBHOOK_URL`; on tamper it exits non-zero and pages, on a
clean run it logs a JSON `ok` line to journal. Like `pg_backup.sh` and the
deploy script (`infra/deploy/deploy.sh`), it reads ONLY the specific `.env`
keys it needs (`POSTGRES_*`, `SLACK_WEBHOOK_URL`) instead of `source`-ing
the whole file — so secrets never enter the cron/child-process environment.
(2026-05-29 audit hardening; `deploy.sh` was switched to read just
`DATABASE_URL` in the same pass.)

### Pre-launch todos

Before accepting real money:

1. ~~Off-host copy~~ — **wired 2026-08-26**. Operator workstation runs
   Task Scheduler job `OddzillaBackupPull` (daily 09:00 local,
   StartWhenAvailable) executing `D:\AI\OddzillaBackups\pull.ps1` — a
   sha256-verified variant of
   [`infra/local/pull-backup.ps1`](../infra/local/pull-backup.ps1) that
   pulls the newest dump into `D:\AI\OddzillaBackups\`, verifies the
   hash against the box, and keeps the newest 7 locally (~40 GB). With
   this in place the on-box cron pins `RETENTION_COUNT=1`.
2. Continuous WAL archiving (`archive_mode=on`, `archive_command` to
   a Hetzner Storage Box or S3 bucket). Enables point-in-time recovery.
3. Weekly restore drill on a sandbox box. A backup you haven't
   restored is a backup you don't have.

## Restore playbook

1. Stop services: `make down`.
2. Wipe the volume: `docker volume rm oddzilla_postgres-data` (**destructive**).
3. Bring up only postgres: `docker compose up -d postgres`.
4. Pipe the latest dump in:
   ```bash
   aws s3 cp s3://bucket/backups/YYYY-MM-DD.sql.age - \
     | age -d -i <identity> \
     | docker compose exec -T postgres psql -U oddzilla -d oddzilla
   ```
5. Check a sample: `docker compose exec postgres psql -U oddzilla -d oddzilla -c 'SELECT COUNT(*) FROM users;'`
6. Bring the rest back up: `make up`.

## Incident playbook

### Feed silence (no `odds_change` for > 60 s during live matches)

1. `curl http://localhost:8081/healthz` — feed-ingester up?
2. `docker compose logs --tail=200 feed-ingester | jq 'select(.level != "info")'`.
3. Check Oddin's status page. Check producer status via
   `GET /v1/descriptions/producers`.
4. If producer down → Oddin's problem; set a banner in UI (admin action),
   re-check every 5 min.
5. If our ingester stuck → `docker compose restart feed-ingester`. It will
   read `amqp_state.after_ts` and recover via REST snapshot.

### Settlement lag (tickets accepted > 2 h and still not settled after match end)

1. Is `services/settlement` healthy? (`/healthz`, logs, `docker compose ps`).
2. Is a rollback batch running? Look for long-running transactions in
   `pg_stat_activity` (`state='active' AND query LIKE '%settlements%'`).
3. Check AMQP for unacked messages (Oddin integration dashboard).
4. If stuck on one bad message → look at the latest row in `settlements`,
   inspect `payload_json`, work with Oddin support to reproduce. Note
   settle/cancel rows older than 45 days are pruned by the nightly
   settlements retention (rollback rows are kept forever).

### Wallet-watcher chain reorg

Rare but possible. `deposits` with `status='confirming'` rolled back off-chain:

1. **Reorg detection (PR #130)**: the ETH path captures
   `deposits.block_hash` at insert time and re-verifies the canonical
   chain via `eth_getBlockByNumber` before crediting. If the block hash
   no longer matches at credit time, the row is flipped to
   `status='orphaned'` and the wallet is never credited. Tron path is
   confirmation-driven only (TronGrid's `only_confirmed=true` already
   means events are past finality, ~19 confirmations).
2. If you find a deposit stuck in `confirming` indefinitely (e.g. the
   verifier kept failing because the RPC endpoint was slow), mark it
   manually:
   ```sql
   UPDATE deposits SET status = 'orphaned' WHERE id = '...';
   ```
3. If a credit already happened AND the chain reorg dropped the tx
   AFTER N confirmations (essentially a deep reorg — very unusual on
   Tron, possible-but-rare on ETH if the verifier was bypassed):
   - Insert a compensating `wallet_ledger` entry:
     `INSERT INTO wallet_ledger (user_id, delta_micro, type, ref_type,
     ref_id, memo) VALUES (?, -?, 'adjustment', 'deposit', ?,
     'reorg compensation, see audit')` (the `(adjustment, deposit, X)`
     key is distinct from the original `(deposit, deposit, X)` so the
     unique partial index allows it).
   - `UPDATE wallets SET balance_micro = balance_micro - ? WHERE user_id = ?`.
   - Insert an `admin_audit_log` row describing the situation. The
     row will hash-chain into the audit log automatically — verifier
     confirms via `admin_audit_chain_check()`.

### Withdrawal admin runbook

Withdrawals are admin-driven for MVP — there's no signer service yet.
Workflow per request:

1. User requests via `POST /wallet/withdrawals` → row in `requested`,
   stake locked.
2. Open `/admin/withdrawals?status=requested` and review:
   - Verify the destination address shape (the API regex is loose; do
     a sanity check).
   - Confirm KYC status of the user (when KYC is wired — Phase 8+).
   - Click **Approve** (records optional fee + audit) or **Reject**.
3. After approval:
   - Open the user's deposit address private key in your hardware
     wallet / signer of choice (derive from the master mnemonic at
     the path stored in `deposit_addresses.derivation_path` for that
     user — though typically you'll send from a hot wallet, not the
     user's deposit address).
   - Broadcast the withdrawal transaction. Note the tx hash.
   - Click **Mark submitted (tx hash)** in the admin UI; paste the hash.
4. Watch the chain explorer (Tronscan / Etherscan) for confirmation.
5. Once confirmed: click **Mark confirmed**. This debits the user's
   wallet, releases the lock, writes the `withdrawal` ledger row.
6. If the broadcast fails or the tx is dropped: click **Mark failed**
   with a reason. Lock is released; user gets their funds back.

**4-eyes (PR #130)**: the API enforces that the actor that confirms
must differ from the actor that approved. So the operator workflow is:

- Admin A clicks **Approve**.
- Admin B (anyone different) clicks **Mark submitted** → broadcasts the
  tx → clicks **Mark confirmed**.

A 403 `approver_cannot_confirm` rejects the same actor at the
**Mark confirmed** step. The DB-level CHECK constraint
`withdrawals_distinct_approver_confirmer` is the second line of defence.

The `tx_hash` field is regex-validated per network: ERC20 must be
`^0x[0-9a-fA-F]{64}$`, TRC20 must be `^(0x)?[0-9a-fA-F]{64}$`. TRC20
hashes are normalised to no-prefix form before storage, so the unique
partial index on `(network, tx_hash)` matches operator paste form
regardless of whether they prefixed `0x`.

**Important:** there is no automated check that the on-chain tx
actually paid out the right amount to the right address. Admin is
responsible for verifying. Pre-launch, the signer container will
enforce this via signed payloads.

### Cashout admin runbook

Cashout is on by default, with a 600 s prematch full-stake window and a
5 s acceptance delay. Admin surface is `/admin/cashout`. The cascade is
`market_type → tournament → sport → global`; the most-restrictive
resolved value wins across combo legs.

**Knobs (all editable per scope, audited):**

| Setting | Global default | Effect |
| --- | --- | --- |
| Enabled | `true` | Master kill-switch. Off → users see "feature_disabled" reason. |
| Prematch full-stake window | `600 s` | Within N seconds of placement, while the match has not started, return stake as the offer. 0 disables. |
| Acceptance delay | `5 s` | Server holds the accepted cashout this many seconds before commit, then re-validates. Ranges 0–60. |
| Min offer | `0.10` USDT | Below this, return `below_minimum`. |
| Min value-change gate | `0` (off) | If non-zero, only offer when `\|currentValue/stake − 1\| ≥ bp/10000`. |
| Deduction ladder | `null` | Optional `[{factor, deduction}]` JSON for chapter §2.1.2. Disabled by default — Oddin already ships margined odds. |

**Common operator tasks:**

1. **Disable cashout for one tournament temporarily** (e.g. while
   investigating a mispriced market):
   - `/admin/cashout` → "Add / update cashout config".
   - Scope = Tournament, pick the tournament, Enabled = off.
   - Save. Live within one quote tick (no cache).

2. **Tighten prematch full-stake window for a specific sport** (e.g.
   the user found an exploit in long-running matches):
   - Scope = Sport, pick the sport, set Prematch full-stake to 60 s.
   - Or 0 to disable the cooling-off entirely for that sport.

3. **Raise the minimum offer floor** (cut down cashout-spam tickets):
   - Scope = Global, bump Min offer to e.g. `1.00` USDT.

4. **Add a deduction ladder for combos** (apply house margin on
   cashouts, like Sportradar §2.1.2):
   - Use the JSON textarea, e.g.
     `[{"factor":0.5,"deduction":1.025},{"factor":1,"deduction":1.005},{"factor":5,"deduction":1.075}]`.
   - Sorted ascending by `factor` (= `currentValue/stake`).
   - Apply per-scope; ladder from the highest-priority leg wins for
     combos.

5. **Investigate a customer dispute** ("cashout offer disappeared"):
   - `SELECT * FROM cashouts WHERE ticket_id = '...' ORDER BY requested_at DESC` —
     `unavailable` rows aren't persisted any more, so most rows
     should be `offered` followed by `accepted` / `expired` /
     `errored`. `errored` rows carry a `reason` column — typically
     `drift_offer_dropped` (offer drifted >5% during the acceptance
     delay) or `drift_<reason>` (a leg went inactive / lost).
   - The wallet ledger row is `(type='cashout', ref_type='ticket',
     ref_id=<ticket-id>)`; `delta_micro` is `offer − stake`.

**Throughput sanity:** quote endpoint allows 240/min/user (per
`req.user.id`, not IP). Frontend polls every 5 s. At 1000 concurrent
open tickets that's 200 quotes/sec — comfortable for the single
`api`/`postgres` pair on the current box. Watch `docker stats
oddzilla-api-1` if it ever feels slow.

### Team logos runbook

Logos hot-link directly to Oddin's CDN (`cdn.oddin.gg`). They're our
authorised data partner; their CDN is built for this and they don't
rate-limit or block hot-linking, so we don't bother proxying through
our own server. `competitors.logo_url` stores the full URL exactly as
Oddin returns it.

The source is Oddin's `/v1/sports/{lang}/competitors/{urn}/profile`
endpoint, which returns `icon_path` per competitor. Feed-ingester
already calls that endpoint and caches each `icon_path` into
`competitor_profiles.icon_path` for every team in the match feed
(see `services/feed-ingester/internal/automap/resolver.go`
`CacheCompetitorProfile`). Coverage on prod: ~1861/2135 cached
profiles have an `icon_path` set; the rest fall back to the
`TeamMark` initials block.

**Resolver:**

[`packages/db/src/resolve-logos.ts`](../packages/db/src/resolve-logos.ts)
is one SQL `UPDATE` — copy `competitor_profiles.icon_path` onto
`competitors.logo_url`. No HTTP, no file I/O, sub-second runtime.

```bash
sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
  sh -c "pnpm db:resolve-logos --dry-run"
# Review the output, then run for real:
sudo -n docker exec -w /app/packages/db oddzilla-api-1 \
  sh -c "pnpm db:resolve-logos"
```

Flags: `--force` (also overwrite rows whose `logo_url` is set to
something other than the cached `icon_path` — legacy state cleanup),
`--sport=cs2` (scope to one sport), `--dry-run` (report counts
without writing).

**One-off edit:** `/admin/competitors` lets you paste a manual
logo URL for any team — useful when a team's Oddin logo is
wrong/missing. Edits are audit-logged
(`admin_audit_log.action = 'competitor.update'`); `TeamMark` falls
back to the initials block on `<img onError>` so a stale URL never
breaks the layout.

**Re-run cadence:** when feed-ingester ingests a team for the first
time, it caches the team's Oddin profile asynchronously. Rows added
to `competitors` *after* the resolver ran end up with `logo_url IS
NULL` until the next run. There's no scheduled job today — re-run
manually, or wire one up via `cron` once steady traffic justifies.

### Signer container

The signer ([`services/signer/`](../services/signer/)) is the only
process that holds `HD_MASTER_MNEMONIC`. The API and wallet-watcher
talk to it over a Unix socket on a tmpfs volume.

**Boot check:**
```sh
curl -fsS http://localhost:8086/healthz
# {"status":"ok","uptime_seconds":42}
```

**Signer logs every `/sign` request** at INFO level with the derivation
path, hash, and audit tag. To reconcile the most recent N hashes
against `admin_audit_log`:

```sh
sudo -n docker logs oddzilla-signer-1 --since 24h | jq -c 'select(.event=="sign")'
```

**Restart consequences:** the tmpfs socket volume is recreated on each
container restart; the API reconnects automatically. No on-disk
artefacts of the secret survive a restart.

**Rotation runbook:** see [HD master mnemonic management](#hd-master-mnemonic-management)
below. The signer reads the env var once at boot and `os.Unsetenv`s it,
so updating `.env` and restarting just the signer container rolls a new
mnemonic without exposing the old one to any other process.

### HD master mnemonic management

Currently lives in `HD_MASTER_MNEMONIC` env on `services/api` (for
address derivation) — that's the only process that has it. Notes:

- Loss of this value with the DB intact = users can keep using existing
  deposit addresses but no new addresses can be derived for new users
  without restoring it.
- Loss of this value WITHOUT the DB = funds in deposit addresses are
  unrecoverable (no key, no spend).
- Therefore: **back up `HD_MASTER_MNEMONIC` separately from the DB**.
  Print to paper, age-encrypt and store in two locations, etc.
- Pre-launch this moves into a dedicated signer container; the API
  loses the value entirely and only sees derived addresses returned by
  the signer's RPC.

### WS storm (ws-gateway CPU 100%)

1. Check `docker compose top ws-gateway`.
2. Confirm the per-client 5 msg/s token bucket is active (logs should show
   drops during bursts).
3. If subscribers > configured cap (Phase 4: add cap), shed load by closing
   oldest sockets.
4. Scale out: spawn a second ws-gateway container. Caddy config needs
   sticky sessions by client id — see Phase 4 design.

### Postgres unhealthy

1. `docker compose logs --tail=200 postgres`.
2. Out of disk? `docker system df`, `df -h`.
3. OOM? Check host `dmesg`. The compose file pins
   `shared_buffers=256MB` and `work_mem=8MB` for the 4 GB box.
4. Tuning escape hatch: upgrade box to CPX31 (8 GB), bump `shared_buffers`,
   reboot Postgres container.

### Out of memory on the box

1. `htop` for top offenders.
2. Swap use high? See `free -h`.
3. Check recent deploys — did a new service bloat? `docker compose top`.
4. Emergency: `docker compose stop wallet-watcher` (lowest-criticality
   service — deposit/withdrawal scanners pause; nothing else is
   affected).
5. Permanent fix: upgrade Hetzner plan.

## Backup feed (Bifrost) failover

`services/bifrost-feed` is the standby source for odds, scores, fixtures
and settlements when Oddin's AMQP feed goes silent. Full design in
[`docs/BIFROST_BACKUP_FEED.md`](./BIFROST_BACKUP_FEED.md); this is the
operator view.

**State model.** The **Feed source** switch on `/admin/feed` (Postgres
singleton `feed_control`, migration 0095; `PUT /admin/feed/source`,
audit-logged) has three positions:

| Position | Prod Oddin (AMQP) | Backup Oddin (Bifrost) |
| --- | --- | --- |
| **Auto** (default) | applied | standby; publishes after `BIFROST_TAKEOVER_AFTER_SECONDS` (45 s) with the AMQP connection down AND no delivery, stands down the moment either resumes (an open connection with no deliveries — the post-restart flush + replay ramp — counts as alive) |
| **Prod Oddin only** | applied | never publishes |
| **Backup Oddin** | connection kept, deliveries acked but NOT applied by feed-ingester; **no Oddin feed REST call of any kind** (fixtures, tournament info, competitor profiles, market descriptions, recovery; settlement skips its recovery request too) | forced: publishes regardless of AMQP; fixtures, team names, crests, market and outcome names all come from Bifrost; the alive watchdog guards bifrost-feed's heartbeat and socket instead of AMQP |

**Only Auto moves by itself.** Backup Oddin and Prod Oddin only are manual
positions: nothing in the system changes them, they survive restarts and
deploys (the row lives in Postgres — NOT Redis: on 2026-09-03 the
`allkeys-lru` Redis evicted the first cut's `feed:source*` keys when the
backup stream filled its 256 MB and a forced Backup silently reverted to
Auto; the stream is now time-trimmed and operator state is in
`feed_control`), and a forced Backup keeps publishing whatever AMQP does. That includes the case where Bifrost itself
goes down while Backup is forced — the catalogue then stays dark until an
operator moves the switch; the card shows the socket disconnected.
Operator decision 2026-09-03.

**Backup means Bifrost only, for the feed** (operator decision 2026-09-03).
While the switch is on Backup, feed-ingester and settlement make no call to
Oddin's feed REST host at all: unknown fixtures resolve through Bifrost's
`match` query, market names seed `market_descriptions` from Bifrost's
group names, outcome names land on `market_outcomes.name` and player names
on `player_profiles`, tournament tier stays manual, an AMQP reconnect
neither flushes nor requests a replay, and the alive watchdog suspends the
catalogue if bifrost-feed's heartbeat goes stale or its socket disconnects
for the threshold. Disir widgets, the Havik video player and OBB live in
the api against other Oddin hosts and are untouched. Switching back to Auto
or Prod re-enables REST, runs the flush + replay, and immediately refreshes
market descriptions and competitor profiles to catch up.

Settlement is outside the switch: it always consumes both sources, because
its apply-once dedup makes that safe and cancel / rollback messages exist
only on AMQP. When the switch was never set, the env default
`BIFROST_MODE` (auto / active / off) applies. An empty `BIFROST_API_KEY`
idles the backup regardless (graceful-idle).

**Switching to Backup** (the operator confirms in the UI): feed-ingester
suspends every active market once and acknowledges with
`feed:source:flushed_unix`; bifrost-feed waits for that acknowledgement
(15 s ceiling) and then re-emits every cached match snapshot, so the
catalogue comes back from Bifrost within seconds and the flush can never
land on top of it. **Switching back** to Auto or Prod runs the same
flush + 24 h Oddin replay an AMQP reconnect does. Both transitions are
visible on the card (`feed-ingester applied: …`, `Waiting for … flush`).

**Enable.**

```bash
ssh team@178.104.174.24 "cd /home/team/oddzilla && sed -i 's/^BIFROST_API_KEY=.*/BIFROST_API_KEY=<key>/' .env && make deploy"
```

Then open `/admin/feed`: the **Backup feed (Bifrost)** card must show the
primary alive, the backup in standby, the socket connected as "MaxBet RS"
(client 101) and tracked matches roughly equal to the active offer.
`curl -s http://127.0.0.1:8086/healthz | jq .gate,.feed` gives the same
from the box.

**Drill / planned failover.** Click **Backup Oddin** on `/admin/feed`
and confirm. The card shows `arming` while feed-ingester flushes, then
ACTIVE (forced by switch); `oddsChangesPublished` climbs and
`feed_messages` rows for the window carry routing key `bifrost.backup`.
Click **Auto** when done; feed-ingester replays from Oddin. No container
restart is involved. (The env route still exists for a box with no api:
`BIFROST_MODE=active` + `make recreate bifrost-feed`, but it does not stop
feed-ingester from applying AMQP.)

**Stop consuming without touching the producer.** `BACKUP_STREAM_ENABLED=false`
+ `make recreate feed-ingester settlement`.

**What a real takeover looks like in the logs.** feed-ingester:
`feed silent past threshold — no alive/odds; suspending active catalog`
(20 s). bifrost-feed: `primary feed silent past threshold; backup ACTIVE`
(45 s) then `re-emitting every cached match snapshot`. On AMQP return:
feed-ingester `amqp connected` + `flush-before-recover complete`, then
bifrost-feed `primary feed resumed; backup standing down` within 2 s.

**Key revoked.** bifrost-feed logs `Bifrost rejected the api key` and
retries every 60 s; the card shows the socket disconnected. Nothing is
published; the watchdog-suspended catalogue stays suspended, which is the
safe state. Ask Oddin for a fresh key.

**Risk tier while the meta API is down.** Bifrost carries none. Assign it
by hand on `/admin/tournaments` (Risk tier column → Edit → `T<n> manual`);
the lock keeps the REST refresh from overwriting it. `Auto` hands the
value back to Oddin's metadata.

**After a long outage of the whole stack.** Nothing to do by hand. On
reconnect feed-ingester's flush + 24 h Oddin replay rebuilds odds and
re-delivers settlements to both consumers (settlement's durable queue also
kept whatever Oddin published while it was down). If the backup is the
active source, its results sweep re-derives every settlement our DB still
lacks: 3 h back on every 5-minute resync, 24 h back on activation and
every 30 minutes; Bifrost keeps settled markets visible for at least two
weeks. The one thing only the AMQP replay restores is cancels and
rollbacks, and that replay reaches back 24 h.

**Not covered yet.** Cancel and rollback messages are not synthesised
(Bifrost exposes no representation for them; deferred, see the design
doc). A market Oddin cancels during a backup window stays open on our side
until the primary replays it; the stranded-ticket reconciler and admin
manual void are the fallbacks.

## FCM push notifications

Server-side is live as of migration `0058_push_notifications_outbox`.
When a winning ticket settles, `services/settlement` (Go) inserts a
`bet_won` row into `push_notifications_outbox` inside the same tx as
`SettleTicket`, then fires `NOTIFY push_outbox`. The api service's
`startPushOutboxWorker` LISTENs on the channel + sweeps every 30 s,
joins to `user_devices`, and dispatches via Firebase Admin SDK
`sendEachForMulticast`. Dead FCM tokens get soft-revoked on the device
row; transient failures bump `attempts` until `MAX_ATTEMPTS=5`.

**Activation** (operator one-time, takes ~5 min once a Firebase project
exists):

1. Firebase Console → Project settings → Service accounts → **Generate
   new private key**. Download the JSON.
2. On the box:
   ```sh
   sudo install -d -m 750 -o team -g team /srv/oddzilla-firebase
   sudo install -m 600 -o 1000 -g 1000 service-account.json \
     /srv/oddzilla-firebase/service-account.json
   ```
   uid 1000 = the api container's `node` user. `chmod 600` keeps the
   credential from sysadmin scripts that might scan world-readable
   files for secrets.
3. `make recreate api`. Logs should show `push: outbox worker started
   firebase=enabled`. From this point every winning settle pushes.

**Operator surface — queue depth + diagnostics:**

```sql
-- Pending rows: should normally trend to zero. A growing number
-- with last_error NULL = api is down or the worker died; growing
-- with last_error set = transient Firebase failures, look at the
-- error column to triage.
SELECT COUNT(*) AS pending
  FROM push_notifications_outbox
 WHERE sent_at IS NULL;

-- Recent dispatches grouped by outcome.
SELECT date_trunc('hour', sent_at) AS h,
       last_error,
       COUNT(*) AS n
  FROM push_notifications_outbox
 WHERE sent_at >= now() - interval '24 hours'
 GROUP BY 1, 2
 ORDER BY 1 DESC, n DESC;
```

`last_error` values you might see:
- `NULL` — dispatched cleanly.
- `firebase_disabled` — credentials weren't mounted; activation step
  pending. Reset to NULL after activating if you want history clean,
  or leave for the audit trail.
- `no_devices` — user has no live `user_devices` rows. Expected for
  users who haven't installed the mobile app or revoked all tokens.
- `all_tokens_dead` — every device token returned a permanent FCM
  error in one dispatch; the worker soft-revoked them.
- `max_attempts:<msg>` — five transient failures in a row, gave up.
  Usually points to a Firebase project / network misconfig.

**Disabling the worker** (debug only):
```
PUSH_OUTBOX_WORKER_DISABLED=1
```
Settlement keeps writing outbox rows; the api just doesn't dispatch.
Use to bisect "is the push pipeline cause of X" — but remember to
flip back on, otherwise the table grows.

**Client-side wiring** (separate manual step) lives in
[`apps/mobile-android/.../fcm/README.md`](../apps/mobile-android/app/src/main/java/cc/oddzilla/app/fcm/README.md)
— `~15 minutes of work after a Firebase project exists`. Server side
keeps draining (graceful-idle) until then.

## ZillaBoost runbook

Operator-curated odds boosts, at `/admin/boosted-odds`. Rules attach to
a sport, tournament, team, match, single market, or single selection;
most specific wins (`selection > market > match > team > tournament >
sport`).

### The red "!" — boost limited by fair odds

A boost shaves percentage points off the market's *key* (the overround),
and it will **never** take the book to or past fair (key 1.0) — that
would hand the bettor positive EV. So a boost bigger than the market's
remaining margin is silently truncated, and on a market already at or
past fair it does nothing whatsoever.

The `!` next to a rule means exactly that. Hover it: the tooltip gives
how many covered markets are affected, how many are completely dead, and
the largest boost the tightest one can actually deliver.

**What to do:** lower the boost %, or narrow the scope. A big number on a
broad scope (a whole sport) will always clip somewhere, because margin
varies market to market — that is expected, not a bug. Worry when
*most* of the covered markets are flagged, or when any are dead.

Rough guide: esports match-winner books usually carry 5–8pp of margin,
so a boost above ~5pp starts clipping on the tighter ones. Observed on
production 2026-08-28: a 13% match-scope rule was truncated on 96 of its
107 covered markets (tightest book had 7.43pp of headroom), while a 4%
team rule across 182 markets was unaffected.

A rule with no `!` and no clamp data at all covers nothing currently
priced — its match may have gone terminal, or its markets are suspended.

### Team boosts: which markets

A team rule (migration 0093) chooses its span:

- **This team's odds only** — boosts just that team's own outcome, in
  match-winner and map-winner markets. The delta comes out of that
  outcome's own probability, so **the opponent's price does not move**.
  Both teams in one match can each carry their own such boost. Symmetric
  markets (totals, handicaps, correct score) aren't about one team and
  stay unboosted.
- **All markets on their matches** — every market of every match the
  team plays, opponent's side included. The original behaviour and the
  default; existing rules were untouched by the migration.

If a team boost looks like it "isn't working" on totals or handicaps,
check this setting first — team-only skipping them is by design.

### Banners

Ticking "create promo banner" surfaces the rule on the storefront home
page. Market and match scopes show prices; team, tournament and sport
scopes deliberately don't (they span too many markets for one price to
be meaningful) and act as signposts into the filtered match list. A
single selection has no banner shape.

Team brand colours matter here: `/admin/competitors` colours drive both
the banner accent and the AI artwork's palette.

## ZillaBoost graphics banners (image worker)

AI-generated promo art for ZillaBoost banners. Same architecture as the
support-ai bot, and the architecture is the security control: the worker
runs **on the operator PC next to ComfyUI** and dials OUT over HTTPS.

```
worker (operator PC) ──outbound HTTPS──> https://oddzilla.cc/api/webhooks/banner-gen/<secret>/...
   │
   ├──> ComfyUI    http://127.0.0.1:8188   (never leaves that box)
   └──> LM Studio  http://127.0.0.1:1234   (prompt authoring)
```

**ComfyUI must stay bound to 127.0.0.1.** It has no authentication,
executes workflow graphs as the (Administrator) user running it, and
`--enable-manager` installs custom nodes from arbitrary git URLs — a
reachable port 8188 is remote code execution as admin on that machine.
A server-side compose variant reaching the PC over tailscale existed for
a few hours on 2026-08-28 and was reverted the same day; tailscale was
purged from the box. **Do not reintroduce a network path from the
sportsbook to the model PC** — it only needs "make me an image from this
text", which the pull queue already provides.

### Activation

Server side (already done on prod):

```sh
# generate + set BANNER_GEN_TOKEN, then
ssh team@178.104.174.24 "cd /home/team/oddzilla && make recreate api"
```

Empty token → the webhook routes 503 `banner_gen_disabled`; the admin
option still enqueues jobs, which wait. Operator PC side:

```sh
cd services/zillaboost-banner-gen
cp .env.example .env    # ODDZILLA_API_BASE + the SAME BANNER_GEN_TOKEN
pnpm install && pnpm start
```

Run it under Task Scheduler ("At log on") so booting the PC IS the
retry. Keep `IMAGE_MODEL=flux1-dev-fp8.safetensors` pinned on the
RX 7900 XTX box (see below).

### Updating the worker on the GPU box

The box is `DESKTOP-IO524Q2`, reachable as `ssh localserver` from the
operator workstation (key `~/.ssh/localserver_ed25519`). Checkout at
`D:\AI\Oddzilla` on branch `main`; the worker runs as the
**`ZillaboostWorker` scheduled task** (launcher `D:\AI\zillaboost-worker.cmd`,
log `D:\AI\zillaboost-worker.log`) — a scheduled task rather than a bare
process so it survives the SSH session that started it.

**`git pull` does NOT work on that box**: `origin` is HTTPS and there is
no usable credential helper (`could not read Password …`, and the prompt
script needs a TTY the SSH session lacks). Ship the delta as a git
bundle instead — proper git objects, no credential handling:

```sh
# on the workstation, from any checkout
git fetch origin main
git bundle create delta.bundle "<box-HEAD-sha>..origin/main"
scp delta.bundle localserver:D:/AI/delta.bundle
```

then on the box (the checkout is normally clean and at an ancestor of
main, so this fast-forwards):

```powershell
git fetch D:\AI\delta.bundle "refs/remotes/origin/main:refs/remotes/origin/bundlemain"
git merge --ff-only refs/remotes/origin/bundlemain
pnpm install   # load-bearing: the compositor uses sharp, a native module
Stop-ScheduledTask -TaskName ZillaboostWorker
Start-ScheduledTask  -TaskName ZillaboostWorker
git update-ref -d refs/remotes/origin/bundlemain   # tidy the temp ref
Remove-Item D:\AI\delta.bundle
```

Verify the restart actually took new code by checking the heartbeat key
rather than trusting the task state:

```sh
ssh team@178.104.174.24 "sudo -n docker exec oddzilla-redis-1 redis-cli GET bannergen:worker:online"
```

Two PowerShell-over-SSH gotchas that will waste your time otherwise: the
remote shell is **PowerShell, not bash**, and piping a script into
`ssh localserver 'powershell -NoProfile -Command -'` prepends a BOM that
breaks the FIRST line — so make line 1 a comment. Complex quoting inline
after `ssh` gets mangled; pipe a script file.

### Availability model

- **PC off** → nothing polls; jobs sit `pending` and drain on boot. No
  server-side retry machinery exists because none is needed.
- **ComfyUI down, PC on** → the worker probes before claiming and sleeps
  1 h between probes. No jobs claimed, no attempts burned.
- **Generation error** → reported; 1 h backoff per attempt, `failed`
  after 24. Untick + re-tick the graphics option to reset.
- **API blip** → normal poll-interval retry. A job orphaned mid-render
  self-returns when its 15-min claim lease expires.

### What controls image quality

Four levers, in the order they matter. Every one of them is visible in
the `img ready` chip's panel on `/admin/boosted-odds` (prompt + params).

1. **Pixel budget** — `IMAGE_WIDTH` / `IMAGE_HEIGHT`, default 1920x640
   (~1.2 MP). The original 1152x384 was under half what these models
   train at, and under-resourced diffusion is what "AI slop" is: mushy
   faces, melted hands, duplicated subjects. No prompt fixes it. Keep
   both divisible by 64. The plate downscales to `BANNER_OUTPUT_WIDTH`
   (1536) on the way out, which sharpens it and shrinks the upload.
2. **FLUX guidance** — `IMAGE_FLUX_GUIDANCE`, default 2.5. ComfyUI
   applies 3.5 implicitly when no `FluxGuidance` node is in the graph,
   and 3.5 is the over-contrasted, plastic-skin look. Lower is more
   natural; below ~1.8 it starts ignoring the prompt.
3. **Prompt register** — prose, not tags. `services/zillaboost-banner-gen/src/prompt.ts`
   holds a banned-vocabulary list (`cinematic`, `dramatic`, `epic`,
   `depth of field`, `vivid accent colours`, …) that is both forbidden
   in the system prompt and **stripped from the completion** before the
   render, because a small local model agrees and then does it anyway.
4. **Per-title art direction** — `game-vocab.ts` carries `scene` (what
   is in frame) and `style` (how that game actually looks) per sport
   slug, both appended deterministically. A title with no entry falls
   back to generic event photography, which is the one case where a
   banner will look like every other banner. Adding a sport means
   adding an entry.

Team crests and names are NOT rendered — they are composited onto the
finished plate (`compose.ts`, `sharp`) for match / market scope. Sport
and tournament plates stay bare because the storefront lays its own
copy over them.

### Troubleshooting a bad-looking image

Expand the `img ready` chip on `/admin/boosted-odds`: the panel shows the
image beside the exact prompt (Copy button) and the render params.
`seed` + `checkpoint` + prompt reproduce the render by hand in ComfyUI.

| Symptom | Cause |
| --- | --- |
| Wrong game entirely (MOBA rendered as soldiers) | The prompt lost its game clause. `game-vocab.ts` supplies each sport slug's scene as ground truth; check the stored prompt starts from it. |
| Generic, airbrushed, could-be-any-game | Check the stored prompt for the banned vocabulary (`cinematic`, `dramatic`, `vivid accent colours`). If it is there, the worker predates the scrub — update it. If it is absent and the image is still soft, check `width`/`height` in the params: anything under ~1 MP renders like this. |
| Generic art, no team identity | The teams have no `brand_color`. Set them at `/admin/competitors` — the prompt puts each side's colour on its gear and light. With none set the prompt asks only for "clearly different gear colours". |
| No crests or names on a match banner | Either `sharp` is missing on the PC (unpacked new code without `pnpm install` — the worker logs `sharp unavailable` and ships bare plates), or the teams have no `logo_url` (set at `/admin/competitors`). `renderMeta.composed` / `renderMeta.crests` in the panel says which. |
| Crest looks blurry | The source `logo_url` is a small raster. SVG and large PNG crests composite crisply; a 64px PNG cannot. Upload a better one at `/admin/competitors`. |
| Panel says "No prompt recorded" | The worker predates migration 0090/0091 (it only stores what the worker sends). Update the worker — see "Updating the worker on the GPU box" — then regenerate. |
| Legible text / logo shapes in the image | Diffusion limitation. FLUX ignores negative prompts, so the no-text terms only bite on SD3-family checkpoints; on FLUX the positive prompt's "every surface unmarked" tail is the only defence. Regenerate for a different seed. |
| `hipErrorLaunchFailure`, then ComfyUI 500s on every request | `sd3.5_large_fp8_scaled` crashes ROCm on the RX 7900 XTX and wedges the GPU context. Restart the ComfyUI process (`D:\AI\comfyui-server.cmd`) and keep `IMAGE_MODEL` on FLUX. |
| Upload 413s after a successful render | A body-limit regression. The `/complete` route needs its own `bodyLimit` (8 MiB) AND Caddy needs the `@banner_gen_uploads` carve-out above its 1 MiB default. Both must be present. |
| Image refetched on every page view | Caddy's blanket `Cache-Control: no-store` on `/api` must keep excluding the public image byte-serves via the `@api_nocache` matcher; both headers reach the browser and `no-store` wins. |
| White gap down the right edge of the image strip | A storefront layout regression, not a render problem. `BannerArtStrip` full-bleeds by cancelling the card's 10px/12px padding with negative margins, so it needs `maxWidth: "none"` — Tailwind preflight's `img, video { max-width: 100% }` in `@layer base` otherwise clamps `calc(100% + 24px)` back to 100% and the whole 24px lands on the right (the left margin still applies). Measured 2026-08-28: 328px card, 302px image. |
| Composited names too small to read | The overlay is sized against the DISPLAY size (~411x137 in a lobby card on a 1512px desktop), not the 1536x512 file — the plate downscales ~3.7x. Anything under ~45px in the file arrives under 12px on screen. Geometry lives in `compose.ts` `geometry()`. |

### Where to look

- Worker log on the PC — `job start` → `prompt authored` → `submitting
  comfyui workflow` → `job complete`.
- Admin `/admin/boosted-odds` — "Image worker online/offline" dot
  (heartbeat, Redis `bannergen:worker:online`, TTL 90 s) + queue counts.
- Queue state:

```sh
ssh team@178.104.174.24 "sudo -n docker exec oddzilla-postgres-1 psql -U oddzilla -d oddzilla -c \"SELECT rule_id, status, attempts, left(last_error,60) FROM zillaboost_banner_image_jobs\""
```

Note images cascade away with their rule: deleting a boost rule deletes
its job row and image.

## OZ demo currency backfill

When migration 0014 runs on an existing environment, pre-existing users
only have a USDT wallet. To grant the OZ demo balance to all of them,
run this **idempotent** SQL (the unique partial index on
`wallet_ledger(type, ref_type, ref_id) WHERE ref_id IS NOT NULL` blocks
double-credits even on retry):

```sql
BEGIN;

INSERT INTO wallets (user_id, currency, balance_micro, locked_micro)
SELECT id, 'OZ', 1000000000, 0
  FROM users
ON CONFLICT (user_id, currency) DO NOTHING;

INSERT INTO wallet_ledger (user_id, currency, delta_micro, type, ref_type, ref_id, memo)
SELECT id, 'OZ', 1000000000, 'adjustment', 'signup_bonus', id::text, 'demo OZ signup backfill'
  FROM users
ON CONFLICT DO NOTHING;

COMMIT;
```

Run from the host through the postgres container:

```bash
ssh team@<host> 'sg docker -c "docker compose exec -T postgres sh -c \
  '"'"'psql -U \$POSTGRES_USER -d \$POSTGRES_DB'"'"'"' < backfill.sql
```

To bulk-credit OZ for testing (e.g. raise everyone's balance), insert a
new ledger row with a fresh `ref_id` (e.g. `'<user_id>:test-credit-1'`)
plus a matching `UPDATE wallets SET balance_micro = balance_micro + ?`
in the same transaction.

## Access management

- SSH keys in `/home/team/.ssh/authorized_keys`. Add a collaborator by
  appending their public key; remove by deleting their line.
- Admin UI access is gated by `role='admin'` on the `users` row. Promote
  a user:
  ```sql
  UPDATE users SET role='admin' WHERE email='person@example.com';
  ```
  This should also write a row to `admin_audit_log` (done via UI in Phase 8;
  for direct SQL promotion, do it manually).
- Revoke all refresh tokens for a user (force logout everywhere):
  ```sql
  UPDATE sessions SET revoked_at = NOW()
    WHERE user_id = (SELECT id FROM users WHERE email=$1)
      AND revoked_at IS NULL;
  ```

## Data protection

- Never log `password_hash`, refresh tokens, raw KYC documents, HD seed
  derivatives, full card numbers (we don't take cards — MVP is USDT only).
- Don't paste user emails into third-party chat tools. Use user IDs.
- `admin_audit_log` must be append-only in practice; do not DELETE rows.

## Reset the world (local dev only)

```bash
make nuke         # docker compose down -v — DESTROYS volumes
make up
make migrate
make seed
```

Never run `make nuke` on production. There is no undo.
