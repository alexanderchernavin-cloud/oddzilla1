#!/usr/bin/env bash
# Oddzilla server bootstrap for the Hetzner CPX22 (Ubuntu 24.04).
# Run ONCE from the team account with sudo: `bash infra/hetzner/bootstrap.sh`.
#
# Idempotent: re-running should be safe. Does not overwrite existing Docker
# state. Does not start any Oddzilla services — use `make up` once the repo is
# cloned and `.env` is filled in.

set -euo pipefail

step() { printf "\n\033[1;36m==> %s\033[0m\n" "$*"; }

step "Updating apt index"
sudo apt-get update -y

step "Installing base packages"
sudo apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release git ufw htop jq make wget

step "Configuring UFW (keep ssh, open 80/443)"
sudo ufw allow OpenSSH >/dev/null || true
sudo ufw allow 80/tcp >/dev/null || true
sudo ufw allow 443/tcp >/dev/null || true
sudo ufw --force enable >/dev/null

if ! command -v docker >/dev/null 2>&1; then
  step "Installing Docker Engine + compose plugin"
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
    sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | \
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  step "Docker already installed; skipping"
fi

step "Allowing the team user to run docker without sudo"
sudo groupadd docker 2>/dev/null || true
sudo usermod -aG docker team

step "Ensuring swap exists (2 GB)"
if ! swapon --show | grep -q '^'; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
else
  echo "swap already enabled"
fi

step "Done."
echo
echo "Next steps:"
echo "  1. git clone <repo> /home/team/oddzilla"
echo "  2. cd /home/team/oddzilla && cp .env.example .env && edit .env"
echo "  3. make up && make migrate && make seed"
