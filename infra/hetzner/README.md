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

## RAM notes

CPX22 = 4 GB. Baseline steady-state estimate ≈ 1.9 GB. The 2 GB swap created
by `bootstrap.sh` covers bursts. Watch `htop` during first live-odds runs in
phase 4 — if RSS climbs past 3 GB sustained, upgrade to CPX31 (8 GB) via the
Hetzner Cloud console (reboot required; data volumes preserved).
