import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { isPrivateIp, sameSite } from "@/lib/berth/net";
import type { DockResult, DockStatus, DockView, Step, Surface, SurfaceControl } from "@/lib/berth/types";

const VIEW_W = 1100;
const VIEW_H = 720;
const MAX_CHROME = 2;
const MAX_MODEL_CALLS = 12;
const MAX_MISSES = 3;
const TASK_WINDOW_MS = 10 * 60 * 1000;
const TASK_BUDGET = 16;

type Decision = {
  action: "click" | "type" | "select" | "clickAt" | "scroll" | "scrollUp" | "press" | "done" | "hold";
  target: string;
  text: string;
  useVault: boolean;
  sensitive: boolean;
  summary: string;
  reason: string;
};

type PWLocator = {
  or(other: PWLocator): PWLocator;
  first(): PWLocator;
  click(opts?: { timeout: number }): Promise<void>;
  fill(value: string, opts?: { timeout: number }): Promise<void>;
  selectOption(option: { label: string }, opts?: { timeout: number }): Promise<unknown>;
  count(): Promise<number>;
};

type PWPage = {
  url(): string;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Buffer>;
  evaluate<T>(fn: () => T): Promise<T>;
  getByRole(role: string, opts?: { name?: string }): PWLocator;
  getByLabel(name: string): PWLocator;
  getByPlaceholder(name: string): PWLocator;
  getByText(text: string, opts?: { exact?: boolean }): PWLocator;
  locator(selector: string): PWLocator;
  mouse: {
    click(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    wheel(dx: number, dy: number): Promise<void>;
  };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  goBack(opts?: { timeout: number }): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
};

type PWContext = {
  pages(): PWPage[];
  newPage(): Promise<PWPage>;
  close(): Promise<void>;
};

type ChromiumApi = {
  launch(opts: { headless: boolean; args: string[]; timeout: number }): Promise<{
    newContext(opts: {
      viewport: { width: number; height: number };
      colorScheme: "light";
    }): Promise<PWContext>;
    close(): Promise<void>;
  }>;
  launchPersistentContext(
    dir: string,
    opts: {
      headless: boolean;
      viewport: { width: number; height: number };
      colorScheme: "light";
      args: string[];
      timeout: number;
    },
  ): Promise<PWContext>;
};

type ChromeDock = {
  kind: "chrome";
  id: string;
  homeUrl: string;
  context: PWContext;
  page: PWPage;
  touched: number;
};

type ReaderDock = {
  kind: "reader";
  id: string;
  homeUrl: string;
  url: string;
  html: string;
  extracted?: { title: string; text: string; controls: SurfaceControl[] };
  touched: number;
};

type Dock = ChromeDock | ReaderDock;

const docks = new Map<string, Dock>();
const secrets = new Map<string, string>();
const pending = new Map<string, Decision>();
const taskStamps: number[] = [];
const queues = new Map<string, Promise<unknown>>();
let chromeFailedAt = 0;

declare global {
  // eslint-disable-next-line no-var
  var __berthStepBus: Map<string, Set<(label: string) => void>> | undefined;
}
if (!globalThis.__berthStepBus) globalThis.__berthStepBus = new Map();
const stepBus = globalThis.__berthStepBus;

declare global {
  // eslint-disable-next-line no-var
  var __berthActiveDockId: string | null;
}
if (!("__berthActiveDockId" in globalThis)) globalThis.__berthActiveDockId = null;

export function getActiveDockId(): string | null {
  return globalThis.__berthActiveDockId;
}

function emitStep(id: string, label: string) {
  stepBus.get(id)?.forEach((cb) => cb(label));
}

export function subscribeSteps(id: string, cb: (label: string) => void): () => void {
  let subs = stepBus.get(id);
  if (!subs) {
    subs = new Set();
    stepBus.set(id, subs);
  }
  subs.add(cb);
  return () => {
    subs!.delete(cb);
    if (!subs!.size) stepBus.delete(id);
  };
}

export async function captureScreenshot(id: string): Promise<Buffer | null> {
  try {
    const clean = cleanId(id);
    const dock = docks.get(clean);
    if (dock?.kind !== "chrome") return null;
    return await dock.page.screenshot({ type: "jpeg", quality: 46 });
  } catch {
    return null;
  }
}

const CHROME_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--ozone-platform=x11",
  "--no-first-run",
  "--no-default-browser-check",
  ...(typeof process.getuid === "function" && process.getuid() === 0
    ? ["--no-sandbox", "--disable-setuid-sandbox"]
    : []),
];
const KEYS = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"]);
const SENSITIVE_RE =
  /\b(pay|purchase|buy now|delete|place order|send money|checkout|transfer|subscribe|change password|reset password)\b/i;

const dnsCache = new Map<string, { ips: string[]; at: number }>();
const DNS_TTL = 60_000;

async function resolveHost(host: string): Promise<string[]> {
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < DNS_TTL) return cached.ips;
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true })).map((r) => r.address);
  dnsCache.set(host, { ips, at: Date.now() });
  return ips;
}

function enqueueFor<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  queues.set(key, run.then(() => undefined, () => undefined));
  return run;
}

function fail(error: unknown): DockResult {
  const message = error instanceof Error ? error.message : "The dock failed.";
  return { ok: false, error: message };
}

function cleanId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error("Unknown dock.");
  return id;
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That address isn't a usable URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only ordinary web addresses.");
  }
  if (url.username || url.password) throw new Error("Don't put a login in the address.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("That address stays off this dock.");
  }
  let ips: string[] = [];
  try {
    ips = await resolveHost(host);
  } catch {
    throw new Error("That site didn't resolve.");
  }
  if (ips.length === 0 || ips.some((ip) => isPrivateIp(ip))) {
    throw new Error("That address isn't a public site.");
  }
  return url;
}

function looksLikeChallenge(title: string, text: string, url: string): boolean {
  const head = `${title}\n${url}`.toLowerCase();
  if (
    head.includes("just a moment") ||
    head.includes("attention required") ||
    head.includes("cdn-cgi/challenge") ||
    head.includes("captcha")
  ) {
    return true;
  }
  if (text.length > 1800) return false;
  const body = text.toLowerCase();
  return (
    body.includes("verify you are human") ||
    body.includes("verify you're human") ||
    body.includes("unusual traffic") ||
    body.includes("are you a robot")
  );
}

function decode(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 32 || code > 0x10ffff) return " ";
      return String.fromCodePoint(code);
    });
}

function extractHtml(html: string, base: string): { title: string; text: string; controls: SurfaceControl[] } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const controls: SurfaceControl[] = [];
  const linkRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(stripped)) && controls.length < 24) {
    const label = decode(match[2] ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!label) continue;
    let href = match[1] ?? "";
    try {
      href = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!href.startsWith("http://") && !href.startsWith("https://")) continue;
    controls.push({ tag: "a", label, href });
  }
  const text = decode(stripped.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 8000);
  return { title, text, controls };
}

async function readPage(url: string): Promise<{ finalUrl: string; html: string }> {
  let current = (await assertPublicUrl(url)).toString();
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Berth/1.0",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The site redirected without a destination.");
      current = (await assertPublicUrl(new URL(location, current).toString())).toString();
      continue;
    }
    if (!response.ok) throw new Error(`The site answered ${response.status}.`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("html") && !type.includes("text/plain") && type !== "") {
      throw new Error("That response isn't a page.");
    }
    const html = (await response.text()).slice(0, 400_000);
    return { finalUrl: current, html };
  }
  throw new Error("Too many redirects.");
}

function readerSurface(dock: ReaderDock): Surface {
  if (!dock.extracted) dock.extracted = extractHtml(dock.html, dock.url);
  const ex = dock.extracted;
  return {
    url: dock.url,
    title: ex.title || dock.url,
    image: null,
    text: ex.text.slice(0, 6000),
    controls: ex.controls,
    engine: "reader",
    challenge: looksLikeChallenge(ex.title, ex.text, dock.url),
  };
}

async function loadChromium(): Promise<ChromiumApi> {
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "/workspace/.local/pw-browsers";
  }
  if (!process.env.DISPLAY) process.env.DISPLAY = ":99";
  const importer = new Function("name", "return import(name)") as (name: string) => Promise<{ chromium: ChromiumApi }>;
  const mod = await importer("playwright");
  return mod.chromium;
}

async function openChromeContext(id: string): Promise<PWContext> {
  const chromium = await loadChromium();
  const dir = path.join(process.cwd(), ".local", "berth-profiles", id);
  try {
    await mkdir(dir, { recursive: true });
    return await chromium.launchPersistentContext(dir, {
      headless: false,
      viewport: { width: VIEW_W, height: VIEW_H },
      colorScheme: "light",
      args: CHROME_ARGS,
      timeout: 20000,
    });
  } catch (error) {
    console.error("[berth] persistent chrome failed:", error);
    const browser = await chromium.launch({ headless: false, args: CHROME_ARGS, timeout: 20000 });
    const ctx = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, colorScheme: "light" });
    (ctx as unknown as { on?: (ev: string, fn: () => void) => void }).on?.("close", () =>
      browser.close().catch(() => undefined),
    );
    return ctx;
  }
}

async function evictChrome(keepId: string) {
  const open = [...docks.values()].filter((dock): dock is ChromeDock => dock.kind === "chrome");
  if (open.length < MAX_CHROME) return;
  open.sort((a, b) => a.touched - b.touched);
  let count = open.length;
  for (const dock of open) {
    if (dock.id === keepId) continue;
    await dock.context.close().catch(() => undefined);
    docks.delete(dock.id);
    count--;
    if (count < MAX_CHROME) return;
  }
}

async function ensureChrome(id: string, homeUrl: string, currentUrl: string): Promise<ChromeDock | null> {
  if (Date.now() - chromeFailedAt < 20_000) return null;
  const existing = docks.get(id);
  if (existing?.kind === "chrome") {
    existing.touched = Date.now();
    existing.homeUrl = homeUrl;
    if (existing.page.url() === "about:blank") {
      await existing.page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    }
    return existing;
  }
  if (existing?.kind === "reader") docks.delete(id);
  try {
    await evictChrome(id);
    const context = await openChromeContext(id);
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(8000);
    await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    const dock: ChromeDock = { kind: "chrome", id, homeUrl, context, page, touched: Date.now() };
    docks.set(id, dock);
    return dock;
  } catch (error) {
    chromeFailedAt = Date.now();
    console.error("[berth] chrome launch failed:", error);
    return null;
  }
}

async function ensureReader(id: string, homeUrl: string, currentUrl: string): Promise<ReaderDock> {
  const existing = docks.get(id);
  if (existing?.kind === "reader" && existing.url === currentUrl) {
    existing.touched = Date.now();
    existing.homeUrl = homeUrl;
    return existing;
  }
  const read = await readPage(currentUrl);
  const dock: ReaderDock = {
    kind: "reader",
    id,
    homeUrl,
    url: read.finalUrl,
    html: read.html,
    touched: Date.now(),
  };
  docks.set(id, dock);
  return dock;
}

async function ensure(id: string, homeUrl: string, currentUrl: string): Promise<Dock> {
  const home = await assertPublicUrl(homeUrl);
  const current = await assertPublicUrl(currentUrl);
  if (!sameSite(home.toString(), current.toString())) {
    throw new Error("That leaves this dock's site.");
  }
  const chrome = await ensureChrome(id, home.toString(), current.toString());
  if (chrome) return chrome;
  return ensureReader(id, home.toString(), current.toString());
}

async function captureChrome(dock: ChromeDock): Promise<Surface> {
  const url = dock.page.url();
  const [evalResult, shotResult] = await Promise.allSettled([
    dock.page.evaluate(() => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 2 && rect.height > 2 && style.visibility !== "hidden" && style.display !== "none";
      };
      const found: { tag: string; label: string; href?: string }[] = [];
      const nodes = document.querySelectorAll("a, button, input, textarea, select, [role='button'], [role='link']");
      for (const el of nodes) {
        if (found.length >= 50) break;
        if (!visible(el)) continue;
        const label = (
          el.getAttribute("aria-label") ||
          el.textContent ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (!label) continue;
        const href = el.tagName === "A" ? (el as HTMLAnchorElement).href || undefined : undefined;
        found.push({ tag: el.tagName.toLowerCase(), label, href });
      }
      return {
        title: document.title,
        text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 8000),
        controls: found,
      };
    }),
    dock.page.screenshot({ type: "jpeg", quality: 46 }),
  ]);
  const title = evalResult.status === "fulfilled" ? evalResult.value.title : "";
  const text = evalResult.status === "fulfilled" ? evalResult.value.text : "";
  const controls = evalResult.status === "fulfilled" ? evalResult.value.controls : [];
  const image =
    shotResult.status === "fulfilled"
      ? `data:image/jpeg;base64,${shotResult.value.toString("base64")}`
      : null;
  return {
    url,
    title: title || url,
    image,
    text: text.slice(0, 6000),
    controls: controls.slice(0, 30),
    engine: "chrome",
    challenge: looksLikeChallenge(title, text, url),
  };
}

async function capture(dock: Dock, open = false): Promise<Surface> {
  if (dock.kind === "reader") return readerSurface(dock);
  const surface = await captureChrome(dock);
  if (!open && surface.url.startsWith("http") && !sameSite(dock.homeUrl, surface.url)) {
    await dock.page.goBack({ timeout: 8000 }).catch(() => undefined);
    const back = await captureChrome(dock);
    return back;
  }
  return surface;
}

function offsiteHold(surface: Surface, homeUrl: string): boolean {
  return surface.url.startsWith("http") && !sameSite(homeUrl, surface.url);
}

function viewFrom(surface: Surface, extras?: Partial<DockView> & { vaultHeld?: boolean }): DockView {
  return {
    ok: true,
    surface,
    vaultHeld: extras?.vaultHeld ?? false,
    steps: extras?.steps ?? [],
    summary: extras?.summary ?? "",
    status: extras?.status ?? (surface.challenge ? "challenge" : "ready"),
    pendingLabel: extras?.pendingLabel ?? null,
  };
}

function modelCall() {
  const base = (process.env.LLM_BASE_URL || "https://api.x.ai/v1").replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || "grok-4.5";
  const apiKey = process.env.LLM_API_KEY || process.env.XAI_API_KEY || "";
  const hosted = base.includes("api.x.ai");
  if (hosted && !apiKey) throw new Error("The assistant isn't available on this host.");
  const timeout = Number(process.env.LLM_TIMEOUT_MS || (hosted ? 25000 : 120000));
  // Screenshots go to hosted Grok by default. Set LLM_VISION=1 or 0 to override for other servers.
  const vision = process.env.LLM_VISION ? process.env.LLM_VISION === "1" : hosted;
  return {
    url: `${base}/chat/completions`,
    model,
    apiKey,
    vision,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 120000,
  };
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage = { role: string; content: string | ContentPart[] };

function takeTaskSlot() {
  const now = Date.now();
  while (taskStamps.length > 0 && now - (taskStamps[0] ?? 0) > TASK_WINDOW_MS) taskStamps.shift();
  if (taskStamps.length >= TASK_BUDGET) {
    throw new Error("This host is pausing new tasks for a few minutes.");
  }
  taskStamps.push(now);
}

async function complete(
  call: { url: string; model: string; apiKey: string; timeout: number },
  headers: Record<string, string>,
  messages: ChatMessage[],
  jsonMode: boolean,
  maxTokens = 350,
): Promise<string> {
  const payload: Record<string, unknown> = {
    model: call.model,
    temperature: 0.2,
    max_tokens: maxTokens,
    messages,
  };
  if (jsonMode) payload.response_format = { type: "json_object" };
  let response = await fetch(call.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(call.timeout),
  });
  if (!response.ok && jsonMode) {
    delete payload.response_format;
    response = await fetch(call.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(call.timeout),
    });
  }
  if (!response.ok) throw new Error(`The assistant couldn't answer (${response.status}).`);
  const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text?: unknown }).text ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

async function askModel(input: {
  task: string;
  memory: string;
  vaultHeld: boolean;
  surface: Surface;
  steps: string[];
  finish?: boolean;
  open?: boolean;
}): Promise<Decision> {
  const call = modelCall();
  const controls = input.surface.controls
    .slice(0, 30)
    .map((control) => (control.href ? `- ${control.label} → ${control.href}` : `- ${control.label}`))
    .join("\n");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (call.apiKey) headers.Authorization = `Bearer ${call.apiKey}`;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You operate one website dock. Reply with JSON only, no markdown.",
        '{"action":"click"|"type"|"select"|"clickAt"|"scroll"|"scrollUp"|"press"|"done"|"hold","target":"","text":"","useVault":false,"sensitive":false,"summary":"","reason":""}',
        "Decide the next step yourself. Reply with one step only.",
        "select picks an option from a dropdown: target is the dropdown's label, text is the option to choose.",
        input.surface.image && call.vision
          ? "clickAt clicks a point: target is 'x,y' in pixels of the screenshot, which is 1100 by 720. Use it for custom widgets such as date pickers and time lists that have no usable label."
          : "Use click, type, or select for controls. Do not use clickAt.",
        "If the answer is already on screen, use done and put it in summary. Do not click just to look busy.",
        "Never repeat a step that is already listed.",
        "If the goal needs another page, a menu, search, or a banner out of the way, click, scroll, or type. Do not wait for the user to say click.",
        "Controls show '→ URL' when a link has a known address. To follow one reliably, use click with the full URL as target instead of the label.",
        "Use scroll to reveal content below the fold. Use scrollUp to go back up if you overshot.",
        "To search, use action type and put the query in text. Do not open Chat, Ask AI, or voice chat.",
        "Do not guess personal facts. Do not type a name, passport number, date of birth, address, or card number unless that exact fact is written in the task.",
        input.finish
          ? "No more actions. action must be done. summary answers the task from the visible page. Do not claim a click."
          : "",
        "click target is the visible label only. Never include a tag such as a: or button:.",
        "Never invent or repeat a password. If a login is required and a saved login exists, set useVault true and leave text empty.",
        "If the page is a human check, use hold.",
        "If the step would pay, send money, delete, subscribe, or change a password, set sensitive true and use hold.",
        input.open
          ? "You may leave the start site for any public site the task needs, such as search results. Once there, stay on the sites that answer the task."
          : "Stay on this site.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Task: ${input.task}`,
        `Steps already taken: ${input.steps.length ? input.steps.join(" ") : "(none)"}`,
        `Dock note: ${input.memory || "(none)"}`,
        `Saved login on this host: ${input.vaultHeld ? "yes" : "no"}`,
        `URL: ${input.surface.url}`,
        `Title: ${input.surface.title}`,
        `Visible text:\n${input.surface.text.slice(0, 5000)}`,
        `Controls:\n${controls || "(none listed)"}`,
      ].join("\n\n"),
    },
  ];
  const user = messages[1];
  if (call.vision && input.surface.image && user && typeof user.content === "string") {
    user.content = [
      { type: "text", text: user.content },
      { type: "image_url", image_url: { url: input.surface.image } },
    ];
  }
  const jsonMode = !call.url.includes("api.x.ai");
  let content = await complete(call, headers, messages, jsonMode);
  try {
    return parseDecision(content);
  } catch {
    content = await complete(
      call,
      headers,
      [...messages, { role: "user", content: "Reply with one JSON object only. No other words." }],
      jsonMode,
    );
    return parseDecision(content);
  }
}

async function answerTask(input: {
  task: string;
  surface: Surface;
  steps: string[];
}): Promise<string> {
  const call = modelCall();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (call.apiKey) headers.Authorization = `Bearer ${call.apiKey}`;
  const messages = [
    {
      role: "system",
      content:
        "You are answering a question based on a web page. Write a clear, complete answer in plain prose. " +
        "Do not mention clicking, navigation, or steps taken. Do not mention cookies or cookie banners. " +
        "Only answer from information actually visible on the page. If the page lacks enough detail, say so.",
    },
    {
      role: "user",
      content: [
        `Task: ${input.task}`,
        `Steps taken: ${input.steps.join(" → ")}`,
        `URL: ${input.surface.url}`,
        `Title: ${input.surface.title}`,
        `Page text:\n${input.surface.text.slice(0, 6000)}`,
      ].join("\n\n"),
    },
  ];
  const jsonMode = !call.url.includes("api.x.ai");
  return complete(call, headers, messages, jsonMode, 800);
}

function parseDecision(raw: string): Decision {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    const said = raw.replace(/\s+/g, " ").trim().slice(0, 160);
    throw new Error(said ? `The assistant didn't return a step. It said: ${said}` : "The assistant didn't return a step.");
  }
  const slice = raw.slice(start, end + 1);
  const loosened = slice.replace(/,\s*([}\]])/g, "$1").replace(/"\s+"/g, '","');
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(slice) as Record<string, unknown>;
  } catch {
    try {
      json = JSON.parse(loosened) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  const pick = (key: string) => {
    const match = slice.match(new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`, "i"));
    return match?.[1] ?? "";
  };
  const action = String(json?.action ?? pick("action") ?? "").toLowerCase();
  if (!["click", "type", "select", "clickAt", "scroll", "scrollUp", "press", "done", "hold"].includes(action)) {
    throw new Error("The assistant returned an unknown step.");
  }
  return {
    action: action as Decision["action"],
    target: String(json?.target ?? pick("target")).slice(0, 160),
    text: String(json?.text ?? pick("text")).slice(0, 400),
    useVault: Boolean(json?.useVault),
    sensitive: Boolean(json?.sensitive),
    summary: String(json?.summary ?? pick("summary")).slice(0, 900),
    reason: String(json?.reason ?? pick("reason")).slice(0, 400),
  };
}

function isSensitive(decision: Decision): boolean {
  if (decision.useVault && decision.action === "type") return false;
  return decision.sensitive || SENSITIVE_RE.test(`${decision.target} ${decision.text} ${decision.reason}`);
}

function answerFromPage(summary: string, steps: Step[], surface: Surface): string {
  const labels = [...new Set(surface.controls.map((control) => control.label.trim()).filter(Boolean))].slice(0, 12);
  const claimed = summary.trim();
  const mentionsClick = /^(click|clicked)\b/i.test(claimed);
  const didThatClick = steps.some((step) => {
    if (!step.label.startsWith("Clicked ")) return false;
    const target = step.label.slice("Clicked ".length).replace(/\.$/, "").toLowerCase();
    return target.length > 0 && claimed.toLowerCase().includes(target);
  });
  if (!claimed || (mentionsClick && !didThatClick)) {
    const text = surface.text.replace(/\s+/g, " ").trim().slice(0, 500);
    if (text.length > 40) return text;
    return labels.length ? `Buttons on the page: ${labels.join(", ")}.` : "Done.";
  }
  return claimed;
}

function stepLabel(decision: Decision): string {
  if (decision.action === "done") return "Answered from the page.";
  if (decision.action === "hold") return decision.reason || "Paused for you.";
  if (decision.action === "scroll") return "Scrolled down the page.";
  if (decision.action === "scrollUp") return "Scrolled up the page.";
  if (decision.action === "press") return `Pressed ${KEYS.has(decision.target) ? decision.target : "Enter"}.`;
  if (decision.action === "type" && decision.useVault) return "Used the saved login.";
  if (decision.action === "type") return decision.target ? `Typed into ${decision.target}.` : "Typed into the page.";
  if (decision.action === "select") return `Chose ${decision.text} in ${decision.target || "the menu"}.`;
  if (decision.action === "clickAt") return `Clicked at ${decision.target}.`;
  return decision.target ? `Clicked ${decision.target}.` : "Clicked the page.";
}

function pendingLabel(decision: Decision): string {
  if (decision.useVault) return "This would use the saved login. Approve it, or leave it.";
  if (decision.action === "type") return `This would type into ${decision.target || "the page"}. Approve it, or leave it.`;
  return `This would ${decision.action} ${decision.target || "the page"}. Approve it, or leave it.`;
}

function isRepeated(label: string, history: Step[]): boolean {
  return history.filter((s) => s.label.toLowerCase() === label.toLowerCase()).length >= 2;
}

const COOKIE_RE = /^(reject( all)?|accept( all)?( cookies)?|deny|no( thanks)?|i (agree|accept)|close( cookies)?|dismiss|got it|ok(ay)?|continue without)$/i;

async function dismissCookieBanner(dock: ChromeDock): Promise<boolean> {
  if (dock.kind !== "chrome") return false;
  const page = dock.page;
  try {
    const reject = page
      .getByRole("button", { name: /reject( all( cookies)?)?/i })
      .or(page.getByRole("link", { name: /reject( all( cookies)?)?/i }))
      .first();
    if ((await reject.count()) > 0) {
      await reject.click({ timeout: 3000 });
      await settle(page);
      return true;
    }
    const accept = page
      .getByRole("button", { name: /accept( all( cookies)?)?/i })
      .or(page.getByRole("link", { name: /accept( all( cookies)?)?/i }))
      .first();
    if ((await accept.count()) > 0) {
      await accept.click({ timeout: 3000 });
      await settle(page);
      return true;
    }
  } catch {
    // banner not present or not clickable
  }
  return false;
}

function hasCookieBanner(surface: Surface): boolean {
  const text = surface.text.toLowerCase();
  return (
    (text.includes("cookie") || text.includes("cookies")) &&
    (text.includes("accept") || text.includes("reject") || text.includes("consent"))
  );
}

async function settle(page: PWPage) {
  await page.evaluate(() => document.readyState).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function perform(dock: ChromeDock, decision: Decision) {
  const page = dock.page;
  if (decision.action === "scroll" || decision.action === "scrollUp") {
    await page.mouse.move(VIEW_W / 2, VIEW_H / 2);
    await page.mouse.wheel(0, decision.action === "scrollUp" ? -720 : 720);
    await settle(page);
    return;
  }
  if (decision.action === "press") {
    const key = KEYS.has(decision.target) ? decision.target : "Enter";
    await page.keyboard.press(key);
    await settle(page);
    return;
  }
  if (decision.action === "type") {
    if (decision.useVault) {
      const secret = secrets.get(dock.id);
      if (!secret) throw new Error("No saved login on this host.");
      const field = page.locator("input[type='password'], input[name*='password' i]").first();
      if ((await field.count()) === 0) throw new Error("No password field on this page.");
      await field.fill(secret, { timeout: 5000 });
      await settle(page);
      return;
    }
    const target = decision.target.trim();
    if (target) {
      const field = page.getByLabel(target).or(page.getByPlaceholder(target)).first();
      if ((await field.count()) > 0) {
        await field.fill(decision.text, { timeout: 5000 });
        await settle(page);
        return;
      }
    }
    const search = page.locator("input[name='q'], input[type='search'], textarea[name='q']").first();
    if ((await search.count()) > 0) {
      await search.fill(decision.text, { timeout: 5000 });
      await search.press("Enter");
      await settle(page);
      return;
    }
    const anyInput = page
      .locator("input:not([type='hidden']):not([type='submit']):not([type='button'])")
      .first();
    if ((await anyInput.count()) > 0) {
      await anyInput.fill(decision.text, { timeout: 5000 });
    } else {
      await page.keyboard.type(decision.text);
    }
    await settle(page);
    return;
  }
  if (decision.action === "clickAt") {
    // Coordinates are pixels in the screenshot, which is the viewport size.
    const [x, y] = decision.target.split(",").map((part) => Number(part.trim()));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("The click needs x,y in pixels.");
    await page.mouse.click(Math.min(VIEW_W - 1, Math.max(0, x ?? 0)), Math.min(VIEW_H - 1, Math.max(0, y ?? 0)));
    await settle(page);
    return;
  }
  if (decision.action === "select") {
    const name = decision.target.trim();
    if (!name) throw new Error("The assistant didn't name a menu.");
    const menu = page.getByLabel(name).or(page.getByRole("combobox", { name })).first();
    await menu.selectOption({ label: decision.text }, { timeout: 5000 });
    await settle(page);
    return;
  }
  if (decision.action === "click") {
    const name = decision.target.trim();
    if (!name) throw new Error("The assistant didn't name a control.");
    if (/^https?:\/\//i.test(name)) {
      const next = await assertPublicUrl(name);
      await page.goto(next.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
      await settle(page);
      return;
    }
    const locator = page
      .getByRole("link", { name })
      .or(page.getByRole("button", { name }))
      .or(page.getByLabel(name))
      .or(page.getByPlaceholder(name))
      .or(page.getByText(name, { exact: false }))
      .first();
    await locator.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
    await locator.click({ timeout: 8000 });
    await settle(page);
  }
}

function needsQuery(url: string): boolean {
  try {
    const page = new URL(url);
    const host = page.hostname.toLowerCase();
    const search = /(^|\.)duckduckgo\.com$/.test(host) || /(^|\.)google\.[a-z.]+$/.test(host);
    // Only the bare search home needs a query. Other pages on these hosts (Google Flights, Maps)
    // have no ?q= either and must not be forced into a search box.
    return search && page.pathname === "/" && !page.searchParams.get("q");
  } catch {
    return false;
  }
}

async function guardSite(dock: ChromeDock): Promise<string | null> {
  const url = dock.page.url();
  if (!url.startsWith("http")) return null;
  if (sameSite(dock.homeUrl, url)) return null;
  try {
    const next = await assertPublicUrl(url);
    dock.homeUrl = next.origin;
    return null;
  } catch {
    await dock.page.goBack({ timeout: 8000 }).catch(() => undefined);
    return "That page isn't a public site, so the browser stepped back.";
  }
}

function held(id: string): boolean {
  return secrets.has(id);
}

export function setSecret(id: string, secret: string): { ok: true; held: boolean } | DockResult {
  try {
    const clean = cleanId(id);
    const value = secret.slice(0, 200);
    if (!value) secrets.delete(clean);
    else secrets.set(clean, value);
    return { ok: true, held: secrets.has(clean) };
  } catch (error) {
    return fail(error);
  }
}

export async function closeDock(id: string): Promise<{ ok: true } | DockResult> {
  let clean: string;
  try {
    clean = cleanId(id);
  } catch (e) {
    return fail(e);
  }
  return enqueueFor(clean, async () => {
    try {
      const dock = docks.get(clean);
      if (dock?.kind === "chrome") await dock.context.close().catch(() => undefined);
      docks.delete(clean);
      pending.delete(clean);
      return { ok: true as const };
    } catch (error) {
      return fail(error);
    }
  });
}

export async function viewDock(id: string, homeUrl: string, currentUrl: string): Promise<DockResult> {
  let clean: string;
  try {
    clean = cleanId(id);
  } catch (e) {
    return fail(e);
  }
  return enqueueFor(clean, async () => {
    try {
      const dock = await ensure(clean, homeUrl, currentUrl);
      const surface = await capture(dock);
      const note = offsiteHold(surface, dock.homeUrl) ? "That left this dock's site." : "";
      const status: DockStatus = surface.challenge ? "challenge" : note ? "hold" : "ready";
      return viewFrom(surface, { vaultHeld: held(clean), summary: note, status, pendingLabel: null });
    } catch (error) {
      return fail(error);
    }
  });
}

export async function runTask(input: {
  id: string;
  homeUrl: string;
  currentUrl: string;
  task: string;
  memory: string;
  open?: boolean;
}): Promise<DockResult> {
  let clean: string;
  try {
    clean = cleanId(input.id);
  } catch (e) {
    return fail(e);
  }
  return enqueueFor(clean, async () => {
    try {
      const task = input.task.trim().slice(0, 400);
      const memory = input.memory.trim().slice(0, 400);
      if (!task) throw new Error("Say what you want done.");
      takeTaskSlot();
      pending.delete(clean);
      globalThis.__berthActiveDockId = clean;
      let dock = await ensure(clean, input.homeUrl, input.currentUrl);
      // An open-web task starts at its search page, even if this dock was left somewhere else.
      const onStart = dock.kind === "chrome" && new URL(dock.page.url() || "about:blank").host === new URL(input.currentUrl).host;
      if (input.open && dock.kind === "chrome" && !onStart) {
        await dock.page.goto(input.currentUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await settle(dock.page);
      }
      const steps: Step[] = [];
      let surface = await capture(dock, input.open);
      if (surface.challenge) {
        emitStep(clean, "The site is asking for a person.");
        return viewFrom(surface, {
          vaultHeld: held(clean),
          steps: [{ label: "The site is asking for a person." }],
          summary: "Solve the check on the view, then continue.",
          status: "challenge",
        });
      }
      // Auto-dismiss cookie banners before the task loop
      if (dock.kind === "chrome" && hasCookieBanner(surface)) {
        const dismissed = await dismissCookieBanner(dock);
        if (dismissed) {
          surface = await capture(dock, input.open);
          steps.push({ label: "Dismissed cookie banner." });
          emitStep(clean, "Dismissed cookie banner.");
        }
      }
      let misses = 0;
      for (let i = 0; i < MAX_MODEL_CALLS; i += 1) {
        let finish = i === MAX_MODEL_CALLS - 1;
        let decision = await askModel({
          task,
          memory,
          vaultHeld: held(clean),
          surface,
          steps: steps.map((step) => step.label),
          finish,
          open: input.open,
        });
        if (decision.action === "click" && /chat|ask ai|voice/i.test(decision.target)) {
          steps.push({ label: "Left the chat control alone." });
          continue;
        }
        let forcedSearch = false;
        if (needsQuery(surface.url) && decision.action !== "type") {
          forcedSearch = true;
          finish = false;
          decision = {
            action: "type",
            target: "",
            text: task.split(/[.!?]/)[0]?.replace(/\s+/g, " ").trim().slice(0, 120) || task.slice(0, 120),
            useVault: false,
            sensitive: false,
            summary: "",
            reason: "",
          };
        }
        const label = stepLabel(decision);
        if (!forcedSearch && isRepeated(label, steps)) {
          finish = true;
          decision = await askModel({
            task,
            memory,
            vaultHeld: held(clean),
            surface,
            steps: steps.map((step) => step.label),
            finish: true,
            open: input.open,
          });
        }
        if (!forcedSearch && finish && decision.action !== "done" && decision.action !== "hold") {
          decision = { ...decision, action: "done" };
        }
        // Check hold/sensitive before done/finish so sensitive actions on the last
        // iteration are not silently swallowed.
        if (decision.action === "hold" || isSensitive(decision)) {
          steps.push({ label: stepLabel(decision) });
          emitStep(clean, stepLabel(decision));
          const executable = decision.action !== "hold";
          if (executable) pending.set(clean, decision);
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps,
            summary: decision.reason || decision.summary || "Paused.",
            status: surface.challenge ? "challenge" : "hold",
            pendingLabel: executable ? pendingLabel(decision) : null,
          });
        }
        steps.push({ label: stepLabel(decision) });
        emitStep(clean, stepLabel(decision));
        if (decision.action === "done" || finish) {
          const summary = await answerTask({ task, surface, steps: steps.map((s) => s.label) });
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps,
            summary,
            status: "ready",
          });
        }
        if (dock.kind !== "chrome") {
          if (decision.action === "click") {
            if (!dock.extracted) dock.extracted = extractHtml(dock.html, dock.url);
            const link = dock.extracted.controls.find((control) =>
              control.label.toLowerCase().includes(decision.target.toLowerCase()),
            );
            if (link?.href && sameSite(dock.homeUrl, link.href)) {
              dock = await ensureReader(clean, dock.homeUrl, link.href);
              surface = await capture(dock, input.open);
              continue;
            }
          }
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: "This host is reading the page, not clicking through Chrome." }],
            summary: decision.summary || "Open this dock where Chrome can run to go further.",
            status: "hold",
          });
        }
        let clickMissed = false;
        let missReason = "";
        try {
          const tagged = decision.target.match(/^(?:a|button|input|textarea|select):\s*(.+)$/i);
          if (tagged?.[1]) decision = { ...decision, target: tagged[1].trim() };
          await perform(dock, decision);
        } catch {
          await new Promise((r) => setTimeout(r, 800));
          try {
            await perform(dock, decision);
          } catch (error) {
            missReason = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : String(error);
            if (decision.action === "click") {
              // Try href navigation before giving up
              const target = decision.target.toLowerCase();
              const link = surface.controls.find(
                (c) => c.href && c.label.toLowerCase().includes(target),
              );
              if (link?.href) {
                try {
                  const next = await assertPublicUrl(link.href);
                  await dock.page.goto(next.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
                  await settle(dock.page);
                  steps.push({ label: `Navigated to ${decision.target}.` });
                  emitStep(clean, `Navigated to ${decision.target}.`);
                  clickMissed = false;
                } catch {
                  clickMissed = true;
                }
              } else {
                clickMissed = true;
              }
            } else {
              clickMissed = true;
            }
          }
        }
        if (clickMissed) {
          const missed = `The action failed: ${stepLabel(decision)} ${missReason || "no error reported"}. Try a different way.`;
          console.warn(`[berth] ${clean} ${missed} url=${dock.page.url()}`);
          misses += 1;
          if (misses < MAX_MISSES) {
            // Give the model the failure and let it choose again.
            steps.push({ label: missed });
            surface = await capture(dock, input.open);
            continue;
          }
          surface = await capture(dock, input.open);
          const summary = await answerTask({ task, surface, steps: steps.map((s) => s.label) });
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: missed }],
            summary,
            status: "ready",
          });
        }
        const left = await guardSite(dock);
        if (dock.page.url().includes("#chat")) {
          await dock.page.goBack({ timeout: 8000 }).catch(() => undefined);
          surface = await capture(dock, input.open);
          steps.push({ label: "Left the chat page." });
          continue;
        }
        surface = await capture(dock, input.open);
        // Dismiss cookie banners that appear after navigation
        if (dock.kind === "chrome" && hasCookieBanner(surface)) {
          const dismissed = await dismissCookieBanner(dock);
          if (dismissed) {
            surface = await capture(dock, input.open);
            steps.push({ label: "Dismissed cookie banner." });
            emitStep(clean, "Dismissed cookie banner.");
          }
        }
        if (left) {
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: left }],
            summary: left,
            status: "hold",
          });
        }
        if (surface.challenge) {
          return viewFrom(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: "The site is asking for a person." }],
            summary: "Solve the check on the view, then continue.",
            status: "challenge",
          });
        }
      }
      const summary = await answerTask({ task, surface, steps: steps.map((s) => s.label) });
      return viewFrom(surface, {
        vaultHeld: held(clean),
        steps: [...steps, { label: "Answered from the page." }],
        summary,
        status: "ready",
      });
    } catch (error) {
      return fail(error);
    } finally {
      if (globalThis.__berthActiveDockId === clean) globalThis.__berthActiveDockId = null;
    }
  });
}

export async function gesture(input: {
  id: string;
  homeUrl: string;
  currentUrl: string;
  kind: "click" | "type" | "follow" | "approve" | "dismiss" | "refresh";
  x?: number;
  y?: number;
  text?: string;
  href?: string;
}): Promise<DockResult> {
  let clean: string;
  try {
    clean = cleanId(input.id);
  } catch (e) {
    return fail(e);
  }
  return enqueueFor(clean, async () => {
    try {
      if (input.kind === "dismiss") pending.delete(clean);
      if (input.kind === "refresh") {
        const existing = docks.get(clean);
        if (existing?.kind === "reader") docks.delete(clean);
      }
      const dock = await ensure(clean, input.homeUrl, input.currentUrl);
      const steps: Step[] = [];
      if (input.kind === "approve") {
        const decision = pending.get(clean);
        pending.delete(clean);
        if (!decision) throw new Error("Nothing is waiting for approval.");
        if (dock.kind !== "chrome") throw new Error("Approval needs Chrome on this host.");
        await perform(dock, decision);
        steps.push({ label: stepLabel(decision) });
        const left = await guardSite(dock);
        if (left) steps.push({ label: left });
      } else if (input.kind === "click") {
        if (dock.kind !== "chrome") throw new Error("Clicking the view needs Chrome on this host.");
        const x = Math.min(1, Math.max(0, Number(input.x ?? 0)));
        const y = Math.min(1, Math.max(0, Number(input.y ?? 0)));
        await dock.page.mouse.click(Math.round(x * VIEW_W), Math.round(y * VIEW_H));
        await settle(dock.page);
        const left = await guardSite(dock);
        steps.push({ label: left ?? "Clicked the view." });
      } else if (input.kind === "type") {
        if (dock.kind !== "chrome") throw new Error("Typing needs Chrome on this host.");
        const text = String(input.text ?? "").slice(0, 400);
        if (!text) throw new Error("Nothing to type.");
        await dock.page.keyboard.type(text);
        await settle(dock.page);
        steps.push({ label: "Sent keystrokes to the page." });
      } else if (input.kind === "follow") {
        const href = String(input.href ?? "");
        const next = await assertPublicUrl(href);
        dock.homeUrl = next.origin;
        if (dock.kind === "chrome") {
          await dock.page.goto(next.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
          await settle(dock.page);
        } else {
          const read = await readPage(next.toString());
          dock.url = read.finalUrl;
          dock.html = read.html;
          dock.extracted = undefined;
        }
        steps.push({ label: "Opened the link." });
      }
      const surface = await capture(dock);
      const status: DockStatus = surface.challenge ? "challenge" : "ready";
      return viewFrom(surface, {
        vaultHeld: held(clean),
        steps,
        summary: input.kind === "approve" ? "Approved and done. Run again for the next step." : "",
        status,
        pendingLabel: null,
      });
    } catch (error) {
      return fail(error);
    }
  });
}
