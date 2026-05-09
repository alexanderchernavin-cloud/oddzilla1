# Operations

Deploy, backup, observability, and incident response for the Hetzner CPX22
deployment. See [`CONNECT.md`](../CONNECT.md) for server access credentials.

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
for svc in postgres redis caddy api web ws-gateway feed-ingester odds-publisher settlement bet-delay wallet-watcher; do
  sudo -n docker compose -f docker-compose.yml build $svc
done
sudo -n docker compose -f docker-compose.yml up -d
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

After pushing to `main`. Build only what changed, ONE service at a time —
`docker compose build` (no service arg) parallel-builds every service and
OOMs the 4 GB CPX22 (see `project_build_oom_incident`; the site went dark
~30 min on 2026-05-06 until a Hetzner power cycle). The `make build` /
`make recreate` targets enforce this — they refuse without `SVC=name`.

```bash
# 1. Fast-forward the worktree on the box.
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  git fetch origin main && git reset --hard origin/main"

# 2. (If migrations shipped — see next block.) Run them BEFORE recreating.

# 3. Build the changed services serially and recreate them with --no-deps
#    so dependency containers (postgres, redis, caddy, …) keep running.
for svc in api web feed-ingester; do  # <-- only the services this PR touched
  ssh team@178.104.174.24 "cd /home/team/oddzilla && make build SVC=$svc"
done
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  sudo -n docker compose -f docker-compose.yml up -d --no-deps \
  --force-recreate api web feed-ingester"
```

> **Never run `docker compose build` without a service argument on this
> box.** The `make build` target now refuses bare invocations; `sudo -n
> docker compose build api` (or the `make build SVC=api` shortcut) is the
> safe form.

Migrations are additive — only run when you've shipped one:

```bash
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  PGUSER=\$(grep ^POSTGRES_USER= .env | cut -d= -f2) \
  PGPASS=\$(grep ^POSTGRES_PASSWORD= .env | cut -d= -f2) \
  PGDB=\$(grep ^POSTGRES_DB= .env | cut -d= -f2) \
  DATABASE_URL=\"postgres://\${PGUSER}:\${PGPASS}@127.0.0.1:5432/\${PGDB}?sslmode=disable\" \
  pnpm --filter @oddzilla/db db:migrate"
```

For tighter loops, GitHub Actions can ssh + pull + compose on merge to
`main` (workflow at [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)
— not yet added; add when there's a second collaborator).

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

Each service can boot WITHOUT certain optional vars and degrades
gracefully:

| Service | Required | Optional → effect when absent |
| --- | --- | --- |
| api | DATABASE_URL, REDIS_URL, JWT_SECRET, REFRESH_COOKIE_SECRET, SIGNER_SOCKET_PATH | signer unreachable → `/wallet/deposit-addresses` returns 500 with `SignerUnavailableError` |
| signer | HD_MASTER_MNEMONIC | n/a — only this service reads the mnemonic |
| feed-ingester | DATABASE_URL, REDIS_URL | ODDIN_TOKEN+ODDIN_CUSTOMER_ID absent → idle, health-only |
| settlement | DATABASE_URL, REDIS_URL | ODDIN_TOKEN+ODDIN_CUSTOMER_ID absent → idle, health-only |
| odds-publisher | DATABASE_URL, REDIS_URL | none — runs as soon as redis stream `odds.raw` has entries |
| bet-delay | DATABASE_URL, REDIS_URL | none |
| wallet-watcher | DATABASE_URL | TRON_RPC_URL absent → TRC20 scanner disabled. ETH_RPC_URL absent → ERC20 scanner disabled. Both absent → idle, health-only |
| ws-gateway | REDIS_URL, JWT_SECRET | none |

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
sudo -n docker compose exec web          wget -qO- http://127.0.0.1:3000
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
docker compose logs -f api             # single service
docker compose logs --since=1h feed-ingester | jq 'select(.level=="error")'
```

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
`/var/backups/oddzilla/oddzilla-<TS>.sql.gz` (root:team mode 640), with
5-day retention (was 14; trimmed 2026-05-09 after dumps reached
~2.3 GB/day and 14 × that overlapped the docker-prune cron failure to
fill the 75 GB disk). Set `BACKUP_GPG_RECIPIENT` in `.env` to
GPG-encrypt the dump in addition to gzipping; the file extension
becomes `.sql.gz.gpg`.

Hardening applied in PR #130: the script no longer sources the entire
`.env` into the cron shell environment (every secret was being exported
into the cron PID's `/proc/<pid>/environ`); it now reads only
`POSTGRES_USER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, and
`BACKUP_GPG_RECIPIENT`.

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

### Disk-fill alert (Slack)

[`infra/hetzner/backup/disk_fill_alert.sh`](../infra/hetzner/backup/disk_fill_alert.sh)
posts to a Slack incoming webhook when the root filesystem crosses
`DISK_FILL_THRESHOLD_PCT` (default 80%). Install on the server:

```bash
ssh team@178.104.174.24
sudo cp /home/team/oddzilla/infra/hetzner/backup/disk_fill_alert.sh \
  /usr/local/bin/oddzilla-disk-fill-alert
sudo chmod 750 /usr/local/bin/oddzilla-disk-fill-alert

# Append to root's crontab — every 15 minutes:
sudo crontab -e
# */15 * * * * /usr/local/bin/oddzilla-disk-fill-alert
```

Set `SLACK_WEBHOOK_URL` (and optionally `DISK_FILL_THRESHOLD_PCT`) in
`/home/team/oddzilla/.env`. Without the webhook the script logs a
single JSON line to journal and exits 0 — the next on-call can wire
up an alternative channel without redeploying.

The 2026-04-22 → 2026-04-28 disk-full incident
(`project_disk_full_incident` memory) ran for 6 days before anyone
noticed because postgres was the only loud signal and the
`docker_prune.sh` mitigation is passive. This is the active page.

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

### Pre-launch todos

Before accepting real money:

1. ~~Off-host copy~~ — solved via the PC pull script
   ([`infra/local/pull-backup.ps1`](../infra/local/pull-backup.ps1)).
   Once the operator workstation's Task Scheduler is wired up, dumps
   land off-server within an hour of the server-side cron.
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
   inspect `payload_json`, work with Oddin support to reproduce.

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

- SSH keys in `/home/team/.ssh/authorized_keys`. Add/remove per
  [`CONNECT.md`](../CONNECT.md).
- VNC password rotation via `vncpasswd` on the box (see `CONNECT.md`).
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
