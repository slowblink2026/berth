# Berth

A self-hosted browser agent with an HTTP API. Give it a URL and a task in plain English — it opens Chrome, navigates the page, and returns an answer.

```bash
curl -s -X POST http://your-vps:8080/api/task \
  -H "Authorization: Bearer your-key" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://news.ycombinator.com","task":"What is the top story right now?"}'
```

```json
{
  "ok": true,
  "status": "ready",
  "url": "https://news.ycombinator.com",
  "title": "Hacker News",
  "summary": "The top story is ...",
  "steps": ["Read the page.", "Answered from the page."],
  "pending": null
}
```

## Deploy on a VPS

Ubuntu 22.04 or 24.04. 4 GB RAM minimum; 8 GB if you run a local model alongside Chrome.

```bash
git clone https://github.com/slowblink2026/berth.git
cd berth
sudo BERTH_USER=$USER bash deploy/setup.sh
```

Edit `/etc/berth.env`:

```bash
BERTH_DOMAIN=berth.example.com   # your domain (for Caddy TLS)
BERTH_API_KEY=change-me           # set a strong secret
XAI_API_KEY=xai-...               # or use Ollama / any OpenAI-compatible server
```

Start:

```bash
sudo systemctl start berth
journalctl -u berth -f
```

### Docker

```bash
docker run -d \
  -p 8080:8080 \
  -e BERTH_API_KEY=change-me \
  -e XAI_API_KEY=xai-... \
  --name berth \
  ghcr.io/slowblink2026/berth
```

Build locally:

```bash
docker build -t berth .
docker run -d -p 8080:8080 -e BERTH_API_KEY=change-me -e XAI_API_KEY=xai-... berth
```

## API

### `POST /api/task` — run a task

**Headers**

| Header | Value |
|---|---|
| `Authorization` | `Bearer <BERTH_API_KEY>` |
| `Content-Type` | `application/json` |

**Body**

```json
{
  "url": "https://example.com",
  "task": "Find the cheapest product under $20"
}
```

**Response**

```json
{
  "ok": true,
  "status": "ready",
  "engine": "chrome",
  "url": "https://...",
  "title": "Page title",
  "summary": "The answer to your task",
  "steps": ["Clicked X", "Typed Y", "Scrolled down"],
  "pending": null
}
```

| Field | Description |
|---|---|
| `status` | `ready` — done. `hold` — paused before a sensitive action (see below). `challenge` — hit a CAPTCHA. |
| `elapsed_ms` | How long the task took |
| `model_calls` | How many LLM calls it cost. A simple read of one page is usually one. |
| `partial` | `true` when the task ran out of time, steps or tries and answered with what it had found |
| `summary` | The agent's answer |
| `steps` | What the browser did |
| `pending` | When `status` is `hold`: description of the action waiting for approval |

### `POST /api/task` — approve a held action

When `status` is `hold`, the agent has paused before submitting a form, making a purchase, or another sensitive action. Approve it to proceed:

```json
{
  "url": "https://example.com",
  "approve": true
}
```

Pass the same `url` you used in the original task. The agent executes the pending action and returns the result.

To cancel instead, just start a new task — the pending action is discarded.

### GET equivalent

Both endpoints also accept GET with query params:

```
GET /api/task?url=https://example.com&task=What+is+the+price?
GET /api/task?url=https://example.com&approve=1
```

Optional in the body: `"timeout_ms"` (answer within this long with whatever has been found; default 150000). Set it below your own HTTP timeout so you always get an answer back.

## What makes it quick and hard to lose

- **Numbered controls.** The model is shown every link, button, field, dropdown and suggestion as `[12] text: Station name or code = "Walton"` and points at one by number. Two boxes with the same label are different numbers, and a filled box shows its value.
- **One call for a simple read.** When the step that finds the answer writes a real one, it is used as is.
- **The whole page, not just the top.** The model gets the top of the page plus the passages further down that mention the task's own words.
- **Waits for the page, not the clock.** A step continues as soon as the page stops changing.
- **Lite loading.** Video, fonts and trackers are skipped; images too when screenshots are not sent to the model.
- **Always answers.** Every task returns inside its deadline with what it found and `partial: true`.
- **Recovers.** A crashed tab is replaced, a link that opens a new tab is followed, alert boxes are dismissed, a busy site is never closed to make room, and a Google "unusual traffic" page is swapped for DuckDuckGo.

Tests: `npm run test:berth` (decision and planning logic) and `npm run test:e2e` (the engine against a real Chromium, local pages and a scripted model; set `BERTH_CHROME_PATH` to use an installed browser).

## LLM configuration

| Env var | Default | Description |
|---|---|---|
| `XAI_API_KEY` | — | xAI Grok (default provider) |
| `LLM_BASE_URL` | — | Override to use any OpenAI-compatible server |
| `LLM_MODEL` | — | Model name when using `LLM_BASE_URL` |
| `LLM_API_KEY` | — | API key for `LLM_BASE_URL` server |
| `BERTH_API_KEY` | — | Protects the API. If unset, only localhost can call it. |

### Use Ollama (free, runs on the same VPS)

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen2.5:7b
```

In `/etc/berth.env`:

```bash
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:7b
# leave XAI_API_KEY unset
```

On a 4 GB VPS use `qwen2.5:3b`.

## Update

```bash
bash deploy/update.sh
```

Pulls latest code, reinstalls dependencies, restarts the service.
