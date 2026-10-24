#!/usr/bin/env bash
# Pull the latest code and restart the service.
# Run as the service user (or with sudo -u <user>).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[berth] pulling latest code..."
git pull --ff-only

echo "[berth] installing dependencies..."
npm install --prefer-offline

echo "[berth] restarting service..."
sudo systemctl restart berth

echo "[berth] waiting for service to come up..."
for i in $(seq 1 30); do
  if systemctl is-active --quiet berth; then
    echo "[berth] service is up"
    break
  fi
  sleep 1
done

if ! systemctl is-active --quiet berth; then
  echo "[berth] service failed to start — check: journalctl -u berth -n 50"
  exit 1
fi

echo "[berth] done. Follow logs with: journalctl -u berth -f"
