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
- DNS: `FRONTEND_HOST=s.oddzilla.cc`, `ADMIN_HOST=sadmin.oddzilla.cc`
  (subdomains on `oddzilla.cc`, registered at Porkbun). A records
  point to `178.104.174.24`. Caddy auto-provisions Let's Encrypt
  certs on first hit for both hosts.

## First-time server setup (reference, only if rebuilding)

```bash
ssh team@178.104.174.24
git clone https://github.com/alexanderchernavin-cloud/oddzilla1 ~/oddzilla
cd ~/oddzilla
bash infra/hetzner/bootstrap.sh      # UFW, Docker, swap, team in docker group
sudo usermod -aG docker team          # if bootstrap missed it; then re-ssh
cp .env.example .env
$EDITOR .env                          # fill real secrets, set ODDIN_CUSTOMER_ID via /v1/users/whoami
sg docker -c 'docker compose -f docker-compose.yml build'
sg docker -c 'docker compose -f docker-compose.yml up -d'
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

After pushing to `main`:

```bash
ssh team@178.104.174.24 "cd /home/team/oddzilla && \
  git fetch origin main && git reset --hard origin/main && \
  sg docker -c 'docker compose -f docker-compose.yml build && \
                docker compose -f docker-compose.yml up -d --force-recreate'"
```

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
| `HD_MASTER_MNEMONIC` | BIP39 12/24-word phrase | never in normal ops — rotating is a customer-facing event |
| `TRON_RPC_URL` | TronGrid (mainnet `https://api.trongrid.io`, testnet `https://api.shasta.trongrid.io`) | when plan changes |
| `ETH_RPC_URL` | Alchemy / Infura / QuickNode / self-hosted | when plan changes |

Each service can boot WITHOUT certain optional vars and degrades
gracefully:

| Service | Required | Optional → effect when absent |
| --- | --- | --- |
| api | DATABASE_URL, REDIS_URL, JWT_SECRET, REFRESH_COOKIE_SECRET | HD_MASTER_MNEMONIC absent → `/wallet/deposit-addresses` returns 500 |
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

Each service exposes `/healthz` that pings its dependencies:

| Service | URL (from box) |
| --- | --- |
| api | http://localhost:3001/healthz |
| ws-gateway | http://localhost:3002/healthz |
| web | http://localhost:3000 (HTTP 200) |
| feed-ingester | http://localhost:8081/healthz |
| odds-publisher | http://localhost:8082/healthz |
| settlement | http://localhost:8083/healthz |
| bet-delay | http://localhost:8084/healthz |
| wallet-watcher | http://localhost:8085/healthz |

Docker Compose healthchecks poll these; unhealthy containers restart.

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

Phase-1 baseline: `postgres-data` and `redis-data` are Docker volumes on the
same box. Good enough for dev; not enough for production.

Before accepting real money:

1. Daily full dump, encrypted, to off-site object storage (Hetzner Storage
   Box or S3 elsewhere):
   ```bash
   docker compose exec -T postgres pg_dump -U oddzilla oddzilla \
     | age -r <recipient-key> | aws s3 cp - s3://bucket/backups/$(date +%F).sql.age
   ```
2. Continuous WAL archiving (`archive_mode=on`, `archive_command` to same
   bucket). Enables point-in-time recovery.
3. Weekly restore drill on a sandbox box. A backup you haven't restored is
   a backup you don't have.

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

1. **Today**: wallet-watcher only reads forward — it does not detect
   reorgs. If a deposit gets reorged out before reaching the
   confirmation threshold, it just stops getting confirmations and sits
   stale. If you find one in `confirming` for far longer than
   `Confirmations × block_time` should take, mark it `orphaned`
   manually:
   ```sql
   UPDATE deposits SET status = 'orphaned' WHERE id = '...';
   ```
2. If a credit already happened (chain reorg AFTER N confirmations —
   essentially a deep reorg, very unusual on Tron and ETH):
   - Insert a compensating `wallet_ledger` entry:
     `INSERT INTO wallet_ledger (user_id, delta_micro, type, ref_type,
     ref_id, memo) VALUES (?, -?, 'adjustment', 'deposit', ?,
     'reorg compensation, see audit')` (the `(adjustment, deposit, X)`
     key is distinct from the original `(deposit, deposit, X)` so the
     unique partial index allows it).
   - `UPDATE wallets SET balance_micro = balance_micro - ? WHERE user_id = ?`.
   - Insert an `admin_audit_log` row describing the situation.

A future reorg-detection feature would compare deposit `block_number`
against current chain head + a small lookback to detect deep reorgs;
out of scope for MVP.

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

Storefront match cards and the match-detail header render team logos
when the matching `competitors.logo_url` is set; otherwise they fall
back to the existing initials TeamMark. Admin UI at
`/admin/competitors` lists every team scoped per sport with sport,
search, and "missing logo only" filters.

**One-off edit:**

1. `/admin/competitors`, filter to the relevant sport.
2. Click "Edit" on the row, paste the logo URL (https or absolute
   `/path`), optionally set a `#RRGGBB` brand colour and a short
   abbreviation, Save. The change is audit-logged
   (`admin_audit_log.action = 'competitor.update'`).
3. The `<img onError>` handler in `TeamMark` falls back to the
   initials block silently if the URL 404s; check the row preview to
   confirm it loaded.

**Bulk seed (curated overrides):**

A small curated seed of popular teams with hand-picked URLs and
brand colours lives in [`packages/db/seeds/competitor-logos.json`](../packages/db/seeds/competitor-logos.json)
keyed by `(sport_slug, competitor_slug)`. Use this for teams whose
Liquipedia logo is wrong, missing, or where you want a brand colour
that the resolver can't infer. Apply with:

```bash
ADMIN_EMAIL=admin@oddzilla.local \
ADMIN_PASSWORD='ChangeMeAdmin123!' \
API_BASE_URL=http://localhost:3001 \
  pnpm --filter @oddzilla/db db:seed-logos
```

Idempotent — re-run any time. Missing rows (no matching `(sport_slug,
competitor_slug)` pair) are reported with their reason; this is
expected for teams the feed hasn't delivered yet.

**Bulk auto-resolve via Liquipedia (every team):**

For exhaustive coverage, [`packages/db/src/resolve-logos.ts`](../packages/db/src/resolve-logos.ts)
iterates every active competitor across the supported esports
(`cs2`, `lol`, `valorant`, `dota2`, `ml`, `kog`, `r6`, `sc2`, `cod`,
`aov`, `rocketleague`, `overwatch`, `crossfire`, `sc1`, `w3`),
queries Liquipedia's MediaWiki API in batches of 40 with `prop=
pageimages&piprop=original`, and writes the returned URL back to
`competitors.logo_url`. Idempotent — only fills nulls unless `--force`.
Run **on the production box** so the script has direct DB access and
the data flow stays local:

```bash
ssh team@178.104.174.24
cd /home/team/oddzilla
sudo -n docker exec -i oddzilla-api-1 sh -c '
  cd /repo && DATABASE_URL=$DATABASE_URL pnpm --filter @oddzilla/db db:resolve-logos --dry-run
'
# Review the output, then run for real:
sudo -n docker exec -i oddzilla-api-1 sh -c '
  cd /repo && DATABASE_URL=$DATABASE_URL pnpm --filter @oddzilla/db db:resolve-logos
'
```

Flags: `--force` (overwrite existing logo_url), `--sport=cs2`
(scope to one sport), `--dry-run` (report without writing),
`--concurrency=N` (parallel HTTP, capped at 16 — leave at 4 to
respect Liquipedia's rate limits).

The resolver pauses 2.1 s between batches to honour Liquipedia's
"≤1 query per 2 s" guideline. ~430 active teams across the supported
esports → ≈30 s wall clock.

After the resolver runs, hand-tune any teams whose Liquipedia entry
was wrong via `/admin/competitors`. Curated overrides in the seed
JSON above always take precedence over the resolver because they're
applied last.

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
