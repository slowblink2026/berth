#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04 / 24.04 VPS.
# Run as root or with sudo: sudo bash deploy/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${BERTH_USER:-ubuntu}"

echo "[berth] repo: $REPO_DIR"
echo "[berth] service user: $SERVICE_USER"

# ── system packages ──────────────────────────────────────────────────────────
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg \
  xvfb \
  fonts-liberation fonts-noto-core \
  caddy

# ── Node.js 22 (skip if already present) ─────────────────────────────────────
if ! node --version 2>/dev/null | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "[berth] node $(node --version)"

# ── npm dependencies ──────────────────────────────────────────────────────────
cd "$REPO_DIR"
sudo -u "$SERVICE_USER" npm install --prefer-offline

# ── Playwright Chromium ───────────────────────────────────────────────────────
BROWSERS_DIR="$REPO_DIR/.local/pw-browsers"
mkdir -p "$BROWSERS_DIR"
chown "$SERVICE_USER":"$SERVICE_USER" "$BROWSERS_DIR"
sudo -u "$SERVICE_USER" \
  env PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_DIR" \
  npx playwright install --with-deps chromium

# ── env file (only create if absent) ─────────────────────────────────────────
ENV_FILE="/etc/berth.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$REPO_DIR/deploy/berth.env.template" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"
  echo "[berth] created $ENV_FILE — fill in your API key and domain, then restart"
else
  echo "[berth] $ENV_FILE already exists, skipping"
fi

# ── systemd service ───────────────────────────────────────────────────────────
cp "$REPO_DIR/deploy/berth.service" /etc/systemd/system/berth.service
sed -i "s|__REPO_DIR__|$REPO_DIR|g" /etc/systemd/system/berth.service
sed -i "s|__SERVICE_USER__|$SERVICE_USER|g" /etc/systemd/system/berth.service
systemctl daemon-reload
systemctl enable berth.service

# ── Caddy ─────────────────────────────────────────────────────────────────────
CADDY_SITE_FILE="/etc/caddy/berth.Caddyfile"
cp "$REPO_DIR/deploy/Caddyfile" "$CADDY_SITE_FILE"
# Include it from the main Caddyfile if not already there
MAIN_CADDYFILE="/etc/caddy/Caddyfile"
if ! grep -q "berth.Caddyfile" "$MAIN_CADDYFILE" 2>/dev/null; then
  echo "" >> "$MAIN_CADDYFILE"
  echo "import /etc/caddy/berth.Caddyfile" >> "$MAIN_CADDYFILE"
fi
systemctl enable --now caddy

echo ""
echo "══════════════════════════════════════════════════════"
echo "  Setup complete."
echo ""
echo "  Next steps:"
echo "  1. Edit $ENV_FILE — set BERTH_DOMAIN and XAI_API_KEY"
echo "     (or LLM_BASE_URL / LLM_MODEL for a local model)"
echo "  2. Update /etc/caddy/berth.Caddyfile with your domain"
echo "  3. systemctl start berth"
echo "  4. journalctl -u berth -f"
echo "══════════════════════════════════════════════════════"
