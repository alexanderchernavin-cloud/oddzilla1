# Hetzner provisioning

Server: `178.104.174.24` (Hetzner CPX31, Ubuntu 24.04, shared `team` account).
Access is SSH key-based — append collaborator public keys to
`/home/team/.ssh/authorized_keys`.

## First-time setup

```bash
ssh team@178.104.174.24
git clone <repo-url> ~/oddzilla
cd ~/oddzilla
bash infra/hetzner/bootstrap.sh
# newgrp docker    # or log out/in so the team user picks up docker group
cp .env.example .env
$EDITOR .env       # fill secrets, FRONTEND_HOST/ADMIN_HOST, Oddin token
make up
make migrate
make seed
```

## Scheduled maintenance (root crontab)

These scripts run from **root's** crontab and are installed by `cp`-ing them
to `/usr/local/bin/oddzilla-*` (they are NOT shipped by `make deploy`, which
only builds docker services — re-`cp` after editing any of them here).

| Cron | Script | Job |
| --- | --- | --- |
| `0 3 * * *`   | `oddzilla-pg-backup` (`backup/pg_backup.sh`) | Daily `pg_dump` → `/var/backups/oddzilla`. Count-based retention (`RETENTION_COUNT`, default **2**); prunes BEFORE dumping + atomic `.part` rename so a full disk can't block rotation. |
| `30 3 * * *`  | `oddzilla-odds-retention` (`backup/odds_retention.sh`) | Caps `odds_history` at `ODDS_RETENTION_DAYS` (default **45**; was 60 until 2026-07-02) via batched DELETE. Stops the unbounded growth that filled the disk on 2026-04-22 / 05-09 / 06-09 / 06-17. See OPERATIONS.md → "odds_history retention". |
| `45 3 * * *`  | `oddzilla-settlements-retention` (`backup/settlements_retention.sh`) | Caps `settlements` (9.8 GB on 2026-07-02): NULLs audit `payload_json` after `SETTLEMENTS_STRIP_DAYS` (default **45**), deletes settle/cancel rows after `SETTLEMENTS_RETENTION_DAYS` (default **120**, open-ticket-guarded; rollback rows kept forever). Needs migration 0085. See OPERATIONS.md → "settlements retention". |
| `0 4 * * *`   | `oddzilla-docker-prune` (`backup/docker_prune.sh`) | Build cache > `MAX_USED_SPACE_GB` (default 10), dangling images, long-stopped containers. |
| `0 4 * * *`   | `oddzilla-audit-chain-check` (`backup/audit_chain_check.sh`) | Verifies the `admin_audit_log` SHA-256 hash chain. |
| `*/15 * * * *`| `oddzilla-disk-fill-alert` (`backup/disk_fill_alert.sh`) | Emails the operator (via `oddzilla-alert-email`) when `/` crosses `DISK_FILL_THRESHOLD_PCT` (default 80). |

`oddzilla-alert-email` (`backup/alert_email.sh`) is the shared pager — Resend
HTTP API, reads `EMAIL_PROVIDER_TOKEN` + `ALERT_EMAIL_TO` from `.env`,
graceful-idle (logs + exit 0) when either is unset. The backup + retention +
disk-fill scripts all page through it on failure.

Install / refresh all of them:

```bash
cd ~/oddzilla
for s in pg_backup odds_retention settlements_retention docker_prune disk_fill_alert alert_email audit_chain_check; do
  sudo cp "infra/hetzner/backup/${s}.sh" "/usr/local/bin/oddzilla-${s//_/-}"
done
sudo chmod 750 /usr/local/bin/oddzilla-*
sudo chmod 755 /usr/local/bin/oddzilla-alert-email /usr/local/bin/oddzilla-docker-prune
# one-time, after first installing odds-retention — keep autovacuum ahead of the deletes:
set -a; . ~/oddzilla/.env; set +a
sudo docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "ALTER TABLE odds_history_default SET (autovacuum_vacuum_scale_factor=0, autovacuum_vacuum_threshold=2000000, autovacuum_vacuum_insert_scale_factor=0, autovacuum_vacuum_insert_threshold=2000000);"
# one-time, after first installing settlements-retention (and after migration 0085):
sudo docker exec oddzilla-postgres-1 psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "ALTER TABLE settlements SET (autovacuum_vacuum_scale_factor=0, autovacuum_vacuum_threshold=300000, autovacuum_vacuum_insert_scale_factor=0, autovacuum_vacuum_insert_threshold=2000000);"
sudo crontab -e   # add the rows above if not already present
```

## RAM notes

Box is **CPX31** (8 GB, 4 vCPU, 160 GB) since 2026-05-11 — upgraded from CPX22
(4 GB) to give the 3× Next.js SSR replicas headroom. The 2 GB swap created by
`bootstrap.sh` covers bursts. Baseline steady-state ≈ 4–5 GB.
