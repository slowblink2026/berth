# Berth

Site docks. Chrome stays on this host. You send the task.

## Run on a VPS

Ubuntu, Node.js 22, at least 2 GB of RAM (4 GB is safer).

Do not expose this on the public internet without a password. There is no sign-in. Anyone who can open the panel can browse from the server and spend your xAI key.

```bash
sudo apt update
sudo apt install -y xvfb fonts-liberation fonts-noto-core ca-certificates
npm install
mkdir -p .local/pw-browsers
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/pw-browsers" npx playwright install chromium
export DISPLAY=:99
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/pw-browsers"
export XAI_API_KEY="your-key"
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
npm run dev
```

The panel listens on port 8080. Put Caddy or nginx in front for HTTPS, and keep 8080 off the public firewall.

Site profiles are stored in `.local/berth-profiles`. Vault passwords live in process memory and are cleared when the process stops.
