# Berth

Site docks. Chrome stays on this host. You send the task.

## Run on a VPS

Ubuntu, Node.js 22. Chrome plus a local model wants 8 GB of RAM. 4 GB can run Chrome with a small 3B model, and it will be slow.

Do not expose this on the public internet without a password. There is no sign-in. Anyone who can open the panel can browse from the server.

```bash
git clone https://github.com/slowblink2026/berth.git
cd berth
sudo apt update
sudo apt install -y xvfb fonts-liberation fonts-noto-core ca-certificates
npm install
mkdir -p .local/pw-browsers
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/pw-browsers" npx playwright install chromium
```

Start a virtual display, then the panel:

```bash
export DISPLAY=:99
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/pw-browsers"
Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
npm run dev
```

The panel listens on port 8080. Put Caddy or nginx in front for HTTPS, and keep 8080 off the public firewall.

Site profiles are stored in `.local/berth-profiles`. Vault passwords live in process memory and are cleared when the process stops.

## Assistant

By default the assistant calls xAI. Set a key and leave the model settings alone:

```bash
export XAI_API_KEY="your-key"
```

### Free model on the same VPS

Ollama runs an open-weight model and speaks the same chat API. Leave `XAI_API_KEY` unset.

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b
```

On a 4 GB VPS use `qwen2.5:3b` instead of `7b`. A 7B model needs about 8 GB once Chrome is also open.

```bash
export LLM_BASE_URL=http://127.0.0.1:11434/v1
export LLM_MODEL=qwen2.5:7b
unset XAI_API_KEY
npm run dev
```

`qwen2.5` follows the JSON step format better than most small models. The first reply can take a minute on CPU. A task may ask the model up to three times.

Any other server that implements `POST /v1/chat/completions` works the same way. Do not put that server on port 8080. That port is the panel.

```bash
export LLM_BASE_URL=http://127.0.0.1:8088/v1
export LLM_MODEL=local
export LLM_API_KEY=local
```

Set `LLM_API_KEY` only if that server requires a key.
