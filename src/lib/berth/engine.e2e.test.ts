/**
 * The engine against a real Chromium, local pages and a scripted model.
 * Run with: npm run test:e2e   (needs a Chromium; set BERTH_CHROME_PATH to use a system one)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { rm } from "node:fs/promises";
import path from "node:path";

process.env.NODE_ENV = "test";
process.env.BERTH_TEST_ALLOW_LOOPBACK = "1";
process.env.BERTH_HEADLESS = "1";

const PAGES: Record<string, string> = {
  "/quote": `<title>LMND quote</title><h1>Lemonade, Inc. (LMND)</h1><p>Price 39.87 USD, up 0.08 (+0.19%). As of 3:29 PM EST.</p>
    <img src="/pixel.png"><a href="/news">News</a>`,
  "/trains": `<title>Live departures</title><h1>Live departures</h1>
    <label for="from">From station</label><input id="from" autocomplete="off"><ul id="list"></ul>
    <label for="when">Leaving</label><select id="when"><option>Now</option><option>In 1 hour</option></select>
    <button id="go" disabled>Show departures</button><div id="out"></div>
    <script>
      const from = document.getElementById('from'), list = document.getElementById('list'), go = document.getElementById('go');
      let chosen = '';
      from.addEventListener('input', () => { chosen = ''; go.disabled = true;
        list.innerHTML = from.value.length > 2 ? '<li role="option">Walton-on-Thames (WAL)</li><li role="option">Walton-on-the-Naze (WON)</li>' : ''; });
      list.addEventListener('click', e => { chosen = e.target.textContent; from.value = chosen; list.innerHTML = ''; go.disabled = false; });
      go.addEventListener('click', () => setTimeout(() => { document.getElementById('out').textContent =
        chosen.includes('WAL') ? 'Next to London Waterloo: 08:12 platform 2, on time (' + document.getElementById('when').value + ')' : 'No station chosen'; }, 400));
    </script>`,
  "/tabs": `<title>Tabs</title><a href="/quote" target="_blank">Open quote in new tab</a>`,
  "/alert": `<title>Alert</title><button onclick="alert('Are you sure?'); document.body.append('Confirmed order view')">Show details</button>`,
  "/long": `<title>Long</title>${"<p>Filler paragraph about nothing.</p>".repeat(600)}<p>The drop-off charge at Heathrow is £7 per visit.</p>`,
  "/pay": `<title>Checkout</title><button>Pay now</button>`,
};

type Script = (prompt: string, system: string) => Record<string, unknown>;
let script: Script = () => ({ action: "done", summary: "unscripted" });
let modelCalls = 0;
let scriptError: Error | null = null;
let pixelRequests = 0;
let base = "";
let engine: typeof import("./engine.server.ts");

const refOf = (prompt: string, label: RegExp) => {
  const line = prompt.split("\n").find((l) => /^\[\d+\]/.test(l) && label.test(l));
  assert.ok(line, `no control matching ${label} in:\n${prompt.split("Controls:")[1]}`);
  return Number(line.match(/^\[(\d+)\]/)![1]);
};

const servers: { close(): void }[] = [];
before(async () => {
  const pages = createServer((req, res) => {
    if (req.url === "/pixel.png") {
      pixelRequests += 1;
      res.writeHead(200, { "content-type": "image/png" }).end();
      return;
    }
    const body = PAGES[(req.url ?? "").split("?")[0] ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html" }).end(body ?? "missing");
  });
  const model = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      modelCalls += 1;
      const messages = JSON.parse(raw).messages as { role: string; content: string }[];
      const system = messages[0]?.content ?? "";
      const prompt = messages[1]?.content ?? "";
      let out: string;
      try {
        out = system.startsWith("Answer the task") ? "Written from the page: " + (prompt.match(/£\d+ per visit/)?.[0] ?? "nothing found") : JSON.stringify(script(prompt, system));
      } catch (error) {
        // A failed expectation inside the script: end the task and fail the test with it.
        scriptError = error as Error;
        out = JSON.stringify({ action: "done", summary: "script failed: " + (error as Error).message });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: out } }] }));
    });
  });
  await Promise.all([pages, model].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", r))));
  servers.push(pages, model);
  base = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
  process.env.LLM_BASE_URL = `http://127.0.0.1:${(model.address() as AddressInfo).port}/v1`;
  process.env.LLM_MODEL = "scripted";
  engine = await import("./engine.server.ts");
});

after(async () => {
  for (const id of ["e2e-quote", "e2e-trains", "e2e-tabs", "e2e-alert", "e2e-long1", "e2e-pay00"]) await engine.closeDock(id);
  servers.forEach((s) => s.close());
  await rm(path.join(process.cwd(), ".local", "berth-profiles"), { recursive: true, force: true }).catch(() => undefined);
});

const run = (id: string, page: string, task: string, more: Record<string, unknown> = {}) => {
  modelCalls = 0;
  return engine.runTask({ id, homeUrl: base + page, currentUrl: base + page, task, memory: "", shots: false, ...more });
};
const ok = (r: Awaited<ReturnType<typeof run>>) => {
  const failed = scriptError;
  scriptError = null;
  if (failed) throw failed;
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r;
};

describe("berth engine", () => {
  it("answers a simple read with one model call, in plain text, without loading images", async () => {
    script = (prompt) => {
      assert.match(prompt, /Price 39\.87 USD/);
      return { action: "done", summary: "**LMND** is 39.87 USD as of 3:29 PM EST." };
    };
    const r = ok(await run("e2e-quote", "/quote", "Read the LMND price"));
    assert.equal(r.summary, "LMND is 39.87 USD as of 3:29 PM EST.");
    assert.deepEqual([modelCalls, r.metrics?.modelCalls, r.metrics?.partial], [1, 1, false]);
    assert.equal(pixelRequests, 0);
    assert.equal(r.surface.image, null);
  });

  it("fills a form with suggestions and a list by pointing at controls by number", async () => {
    let step = 0;
    script = (prompt) => {
      step += 1;
      if (step === 1) return { action: "type", ref: refOf(prompt, /From station/), text: "Walton" };
      if (step === 2) return { action: "click", ref: refOf(prompt, /option: Walton-on-Thames/) };
      if (step === 3) return { action: "select", ref: refOf(prompt, /select: Leaving/), text: "In 1 hour" };
      if (step === 4) {
        assert.match(prompt, /From station = "Walton-on-Thames \(WAL\)"/);
        return { action: "click", ref: refOf(prompt, /button: Show departures/) };
      }
      assert.match(prompt, /08:12 platform 2, on time \(In 1 hour\)/);
      return { action: "done", summary: "Next to Waterloo is the 08:12 from platform 2, on time." };
    };
    const r = ok(await run("e2e-trains", "/trains", "Next train from Walton-on-Thames to London Waterloo"));
    assert.match(r.summary, /08:12 from platform 2/);
    assert.equal(r.metrics?.modelCalls, 5);
    assert.deepEqual(r.steps.map((s) => s.label).slice(0, 2), ['Typed "Walton" into From station.', "Clicked Walton-on-Thames (WAL)."]);
  });

  it("carries on in a tab a link opened, and is not frozen by an alert box", async () => {
    let step = 0;
    script = (prompt) => (++step === 1 ? { action: "click", ref: refOf(prompt, /Open quote/) } : (assert.match(prompt, /39\.87 USD/), { action: "done", summary: "Quote page shows 39.87 USD." }));
    assert.match(ok(await run("e2e-tabs", "/tabs", "Open the quote and read the price")).summary, /39\.87/);
    step = 0;
    script = (prompt) => (++step === 1 ? { action: "click", ref: refOf(prompt, /Show details/) } : (assert.match(prompt, /Confirmed order view/), { action: "done", summary: "Details are showing now." }));
    assert.match(ok(await run("e2e-alert", "/alert", "Show the details")).summary, /Details are showing/);
  });

  it("shows the model an answer far down a long page, without a single scroll", async () => {
    script = (prompt) => {
      assert.match(prompt, /£7 per visit/);
      return { action: "done", summary: "The drop-off charge is £7 per visit." };
    };
    const r = ok(await run("e2e-long1", "/long", "What is the Heathrow drop-off charge?"));
    assert.equal(r.metrics?.modelCalls, 1);
  });

  it("always answers inside its deadline, saying it ran out of time", async () => {
    script = () => ({ action: "scroll" });
    const started = Date.now();
    const r = ok(await run("e2e-long1", "/long", "What is the Heathrow drop-off charge?", { deadlineMs: 10_000 }));
    assert.ok(Date.now() - started < 10_000, "returned before the deadline");
    assert.equal(r.metrics?.partial, true);
    assert.match(r.summary, /£7 per visit/);
    assert.match(r.steps.at(-1)?.label ?? "", /Ran out of time|Answered from the page/);
  });

  it("recovers when the tab has died, and tells the model when a step missed", async () => {
    await engine.closeDock("e2e-quote");
    script = () => ({ action: "done", summary: "Fresh page read fine." });
    ok(await run("e2e-quote", "/quote", "Read the price"));
    // Kill the page behind the engine's back: the next task must open a new one.
    const killer = await import("./engine.server.ts");
    await killer.__test.crash("e2e-quote");
    assert.match(ok(await run("e2e-quote", "/quote", "Read the price")).summary, /Fresh page/);
    let step = 0;
    script = (prompt) => {
      step += 1;
      if (step === 1) return { action: "click", target: "A button that is not there" };
      assert.match(prompt, /could not be carried out/);
      assert.match(prompt, /that did not work/);
      return { action: "done", summary: "Could not find that button; the page shows the LMND quote." };
    };
    const r = ok(await run("e2e-quote", "/quote", "Press the missing button"));
    assert.equal(r.status, "ready");
  });

  it("still holds before paying", async () => {
    script = (prompt) => ({ action: "click", ref: refOf(prompt, /Pay now/) });
    const r = ok(await run("e2e-pay00", "/pay", "Buy it"));
    assert.equal(r.status, "hold");
    assert.match(r.pendingLabel ?? "", /Approve it/);
  });
});
