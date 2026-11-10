import { lookup } from "node:dns/promises";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { isPrivateIp, sameSite } from "./net.ts";
import { focusText, isTrackerHost, plainAnswer, searchFallbackUrl } from "./plan.ts";
import type { DockResult, DockStatus, DockView, Step, Surface, SurfaceControl, TaskMetrics } from "@/lib/berth/types";

const VIEW_W = 1100;
const VIEW_H = 720;
function envInt(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= min && value <= max ? Math.round(value) : fallback;
}

const MAX_CHROME = envInt("BERTH_MAX_CHROME", 3, 1, 8);
// A task always answers inside this, with whatever it has: a caller that gives
// up at its own timeout gets nothing back at all.
const TASK_DEADLINE_MS = envInt("BERTH_TASK_DEADLINE_MS", 150_000, 10_000, 600_000);
// Video, fonts and trackers are never needed to do a task. Images are skipped too
// when the model is not being shown screenshots. BERTH_LITE=0 loads everything.
const LITE = process.env.BERTH_LITE !== "0";
const HEADLESS = process.env.BERTH_HEADLESS === "1";
const TEXT_FOR_MODEL = 7000;
const MAX_MODEL_CALLS = 12;
// A form task spends steps on a route, a date, a direction and a passenger count
// before any result is on screen, so it gets a larger budget with a hard cap.
const MAX_FORM_MODEL_CALLS = 24;
const MAX_MISSES = 3;
// A form task meets more custom controls, so it gets more tries before giving up.
const MAX_FORM_MISSES = 5;
// How often the model may be told to pick something else before the task stops.
const MAX_REPEATS = 3;
// A results page that is still loading gets a bounded wait rather than a hold.
const WAIT_MS = 4000;
const MAX_WAITS = 5;
const TASK_WINDOW_MS = 10 * 60 * 1000;
const TASK_BUDGET = envInt("BERTH_TASK_BUDGET", 40, 1, 1000);

type Decision = {
  action: "click" | "type" | "select" | "clickAt" | "scroll" | "scrollUp" | "press" | "wait" | "done" | "hold";
  /** The [number] of a control from the list the model was shown, when it used one. */
  ref?: number | null;
  target: string;
  text: string;
  useVault: boolean;
  sensitive: boolean;
  summary: string;
  reason: string;
};

type PWLocator = {
  or(other: PWLocator): PWLocator;
  and(other: PWLocator): PWLocator;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  first(): PWLocator;
  click(opts?: { timeout: number }): Promise<void>;
  fill(value: string, opts?: { timeout: number }): Promise<void>;
  press(key: string, opts?: { timeout: number }): Promise<void>;
  selectOption(option: { label: string }, opts?: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: (el: Element) => T): Promise<T>;
  count(): Promise<number>;
};

type PWPage = {
  url(): string;
  goto(url: string, opts: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  screenshot(opts: { type: "jpeg"; quality: number }): Promise<Buffer>;
  evaluate<T>(fn: () => T): Promise<T>;
  getByRole(role: string, opts?: { name?: string | RegExp }): PWLocator;
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
  isClosed(): boolean;
  close(): Promise<void>;
  bringToFront(): Promise<void>;
  on(event: "dialog", fn: (dialog: { dismiss(): Promise<void> }) => void): void;
};

type PWRoute = {
  request(): { resourceType(): string; url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
};

type PWContext = {
  pages(): PWPage[];
  newPage(): Promise<PWPage>;
  close(): Promise<void>;
  route(pattern: string, fn: (route: PWRoute) => void): Promise<void>;
};

type ChromiumApi = {
  launch(opts: { headless: boolean; args: string[]; timeout: number; executablePath?: string }): Promise<{
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
      executablePath?: string;
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
// Docks with a task in flight: never closed to make room for another site.
const busy = new Set<string>();
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
  ...(HEADLESS ? [] : ["--ozone-platform=x11"]),
  // Work Chrome does for a person at a desk, not for a task runner.
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--mute-audio",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--no-first-run",
  "--no-default-browser-check",
  ...(typeof process.getuid === "function" && process.getuid() === 0
    ? ["--no-sandbox", "--disable-setuid-sandbox"]
    : []),
];
const KEYS = new Set(["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Backspace", "PageDown", "PageUp"]);
// Whole phrases only. Single words such as "pay", "transfer" or "delete" appear
// in ordinary search results — a train with a transfer at Crewe, a page footer
// about payment — and used to hold a plain search.
const SENSITIVE_RE =
  /\b(pay now|pay with|make (a )?payment|proceed to (checkout|payment|pay)|go to (checkout|payment)|checkout now|place (the |my )?order|buy now|add to (bag|basket|cart)|complete (the |my )?(booking|purchase|order|payment)|confirm (and )?(pay|payment|purchase|order|booking|book)|book (and pay|now)|send money|transfer (money|funds)|wire transfer|card number|security code|cvv|delete (my |the )?(account|card|booking|everything)|permanently delete|close (my )?account|change (my )?password|reset (my )?password|new password|subscribe now|start (my |a )?(free )?trial|sign up and pay)\b/i;
// Only a step that commits something is matched against those phrases. Answering,
// scrolling or holding changes nothing, and its reason often quotes the page.
const COMMITTING_ACTIONS = new Set<Decision["action"]>(["click", "type", "select", "clickAt", "press"]);

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
  // Tests drive a page server on loopback; nothing else may ever switch this on.
  if (process.env.NODE_ENV === "test" && process.env.BERTH_TEST_ALLOW_LOOPBACK === "1" && host === "127.0.0.1") {
    return url;
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
    challenge: false,
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

// With screenshots going to the model, images have to load or it is shown a blank page.
function visionOn(): boolean {
  if (process.env.LLM_VISION) return process.env.LLM_VISION === "1";
  return (process.env.LLM_BASE_URL || "https://api.x.ai/v1").includes("api.x.ai");
}
const HEAVY = new Set(visionOn() ? ["media"] : ["image", "media", "font"]);

async function prepareContext(ctx: PWContext): Promise<PWContext> {
  if (LITE) {
    await ctx
      .route("**/*", (route) => {
        const request = route.request();
        let host = "";
        try {
          host = new URL(request.url()).hostname;
        } catch {
          host = "";
        }
        if (HEAVY.has(request.resourceType()) || isTrackerHost(host)) {
          route.abort().catch(() => undefined);
        } else {
          route.continue().catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }
  return ctx;
}

async function openChromeContext(id: string): Promise<PWContext> {
  const chromium = await loadChromium();
  const dir = path.join(process.cwd(), ".local", "berth-profiles", id);
  const executablePath = process.env.BERTH_CHROME_PATH || undefined;
  try {
    await mkdir(dir, { recursive: true });
    return await prepareContext(
      await chromium.launchPersistentContext(dir, {
        headless: HEADLESS,
        viewport: { width: VIEW_W, height: VIEW_H },
        colorScheme: "light",
        args: CHROME_ARGS,
        timeout: 20000,
        executablePath,
      }),
    );
  } catch (error) {
    console.error("[berth] persistent chrome failed:", error);
    const browser = await chromium.launch({ headless: HEADLESS, args: CHROME_ARGS, timeout: 20000, executablePath });
    const ctx = await browser.newContext({ viewport: { width: VIEW_W, height: VIEW_H }, colorScheme: "light" });
    (ctx as unknown as { on?: (ev: string, fn: () => void) => void }).on?.("close", () =>
      browser.close().catch(() => undefined),
    );
    return prepareContext(ctx);
  }
}

function watchPage(page: PWPage) {
  page.setDefaultTimeout(8000);
  // An alert, confirm or "leave this page?" box freezes the page until answered.
  page.on("dialog", (dialog) => {
    dialog.dismiss().catch(() => undefined);
  });
}

/** A link that opened a new tab: carry on in that tab, and close the one left behind. */
async function followNewTab(dock: ChromeDock) {
  const pages = dock.context.pages().filter((page) => !page.isClosed());
  const newest = pages[pages.length - 1];
  if (!newest || newest === dock.page || pages.length < 2) return;
  const old = dock.page;
  dock.page = newest;
  watchPage(newest);
  await newest.bringToFront().catch(() => undefined);
  await old.close().catch(() => undefined);
}

async function evictChrome(keepId: string) {
  const open = [...docks.values()].filter((dock): dock is ChromeDock => dock.kind === "chrome");
  if (open.length < MAX_CHROME) return;
  open.sort((a, b) => a.touched - b.touched);
  let count = open.length;
  for (const dock of open) {
    if (dock.id === keepId || busy.has(dock.id)) continue;
    await dock.context.close().catch(() => undefined);
    docks.delete(dock.id);
    count--;
    if (count < MAX_CHROME) return;
  }
}

async function ensureChrome(id: string, homeUrl: string, currentUrl: string): Promise<ChromeDock | null> {
  if (Date.now() - chromeFailedAt < 20_000) return null;
  let existing = docks.get(id);
  if (existing?.kind === "chrome") {
    // A crashed tab or a Chrome that was killed leaves a dock that fails every
    // call until the service restarts. Notice it and open a fresh one instead.
    const alive = !existing.page.isClosed() && (await existing.page.evaluate(() => 1).then(() => true, () => false));
    if (!alive) {
      await existing.context.close().catch(() => undefined);
      docks.delete(id);
      existing = undefined;
    }
  }
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
    watchPage(page);
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

async function captureChrome(dock: ChromeDock, opts: { shot?: boolean } = {}): Promise<Surface> {
  const url = dock.page.url();
  const wantShot = opts.shot !== false;
  const [evalResult, shotResult] = await Promise.allSettled([
    dock.page.evaluate(() => {
      const viewH = window.innerHeight;
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 2 || rect.height <= 2) return false;
        const style = getComputedStyle(el);
        return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };
      const clean = (value: string | null | undefined, max = 80) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
      const labelOf = (el: Element) => {
        const input = el as HTMLInputElement;
        const byFor = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : "";
        const labelled = el.getAttribute("aria-labelledby");
        const byId = labelled
          ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
          : "";
        return clean(
          el.getAttribute("aria-label") || byId || byFor || (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT"
            ? el.closest("label")?.textContent || input.placeholder || el.getAttribute("title") || el.getAttribute("name")
            : el.textContent || el.getAttribute("title") || el.getAttribute("value") || (el.querySelector("img[alt]") as HTMLImageElement | null)?.alt),
        );
      };
      const kindOf = (el: Element) => {
        const role = el.getAttribute("role");
        const tag = el.tagName.toLowerCase();
        if (role && ["option", "tab", "menuitem", "checkbox", "radio", "switch", "combobox", "link", "button"].includes(role)) return role;
        if (tag === "a") return "link";
        if (tag === "select") return "select";
        if (tag === "textarea") return "text";
        if (tag === "summary") return "button";
        if (tag === "input") {
          const type = (el.getAttribute("type") || "text").toLowerCase();
          if (["submit", "button", "reset", "image"].includes(type)) return "button";
          if (["checkbox", "radio"].includes(type)) return type;
          return ["search", "email", "password", "tel", "number", "date", "time", "url"].includes(type) ? type : "text";
        }
        return "button";
      };
      document.querySelectorAll("[data-berth-ref]").forEach((el) => el.removeAttribute("data-berth-ref"));
      const nodes = document.querySelectorAll(
        "a[href], button, input:not([type='hidden']), textarea, select, summary, [role='button'], [role='link'], " +
          "[role='option'], [role='tab'], [role='menuitem'], [role='checkbox'], [role='radio'], [role='switch'], [role='combobox'], [contenteditable='true']",
      );
      type Found = { tag: string; label: string; href?: string; kind: string; value?: string; options?: string[]; near: boolean; el: Element };
      const all: Found[] = [];
      const seen = new Set<string>();
      for (const el of nodes) {
        if (all.length >= 400) break;
        if (!visible(el)) continue;
        const off = (el as HTMLButtonElement).disabled === true;
        const kind = kindOf(el);
        const label = labelOf(el);
        const isField = ["text", "search", "email", "password", "tel", "number", "date", "time", "url", "select", "combobox"].includes(kind);
        if (!label && !isField) continue;
        // A greyed-out button does nothing. A greyed-out field often opens when clicked, so it stays.
        if (off && !isField) continue;
        const href = el.tagName === "A" ? (el as HTMLAnchorElement).href || undefined : undefined;
        const key = `${kind}|${label}|${href ?? ""}`;
        if (!isField && seen.has(key)) continue;
        seen.add(key);
        const rect = el.getBoundingClientRect();
        const item: Found = { tag: el.tagName.toLowerCase(), label: label || `(${kind} field)`, href, kind, near: rect.bottom > 0 && rect.top < viewH, el };
        if (el.tagName === "SELECT") {
          const select = el as HTMLSelectElement;
          item.value = clean(select.selectedOptions[0]?.textContent, 60);
          item.options = [...select.options].slice(0, 25).map((o) => clean(o.textContent, 50)).filter(Boolean);
        } else if (isField) {
          item.value = clean((el as HTMLInputElement).value, 60) || undefined;
        } else if (kind === "checkbox" || kind === "radio" || kind === "switch") {
          item.value = (el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true" ? "on" : "off";
        }
        all.push(item);
      }
      // What is on screen first, then fields anywhere on the page, then the rest.
      const fieldKinds = new Set(["text", "search", "email", "password", "tel", "number", "date", "time", "url", "select", "combobox", "option"]);
      const ranked = [...all.filter((x) => x.near), ...all.filter((x) => !x.near && fieldKinds.has(x.kind)), ...all.filter((x) => !x.near && !fieldKinds.has(x.kind))].slice(0, 70);
      const controls = ranked.map((item, index) => {
        item.el.setAttribute("data-berth-ref", String(index + 1));
        const { el: _el, near: _near, ...rest } = item;
        return { ...rest, ref: index + 1 };
      });
      return {
        title: document.title,
        text: (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").slice(0, 60000),
        controls,
        scrolled: Math.round(window.scrollY),
        more: document.documentElement.scrollHeight - window.scrollY - viewH > 200,
      };
    }),
    wantShot ? dock.page.screenshot({ type: "jpeg", quality: 46 }) : Promise.resolve(null),
  ]);
  const title = evalResult.status === "fulfilled" ? evalResult.value.title : "";
  const text = evalResult.status === "fulfilled" ? evalResult.value.text : "";
  const controls = evalResult.status === "fulfilled" ? evalResult.value.controls : [];
  const image =
    shotResult.status === "fulfilled" && shotResult.value
      ? `data:image/jpeg;base64,${shotResult.value.toString("base64")}`
      : null;
  return {
    url,
    title: title || url,
    image,
    text,
    controls,
    engine: "chrome",
    challenge: false,
  };
}

async function capture(dock: Dock, open = false, shot = true): Promise<Surface> {
  if (dock.kind === "reader") return readerSurface(dock);
  const surface = await captureChrome(dock, { shot });
  if (!open && surface.url.startsWith("http") && !sameSite(dock.homeUrl, surface.url)) {
    await dock.page.goBack({ timeout: 8000 }).catch(() => undefined);
    const back = await captureChrome(dock, { shot });
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
    // The model reads the whole page; the view a person sees needs far less.
    surface: { ...surface, text: surface.text.slice(0, 6000), controls: surface.controls.slice(0, 40) },
    vaultHeld: extras?.vaultHeld ?? false,
    steps: extras?.steps ?? [],
    summary: extras?.summary ?? "",
    status: extras?.status ?? (surface.challenge ? "challenge" : "ready"),
    pendingLabel: extras?.pendingLabel ?? null,
    ...(extras?.metrics ? { metrics: extras.metrics } : {}),
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

function controlLine(control: SurfaceControl): string {
  const bits = [`[${control.ref ?? "?"}] ${control.kind ?? control.tag}: ${control.label}`];
  if (control.value) bits.push(`= "${control.value}"`);
  if (control.options?.length) bits.push(`options: ${control.options.join(" | ")}`);
  if (control.href) bits.push(`→ ${control.href.slice(0, 160)}`);
  return bits.join(" ");
}

async function askModel(input: {
  task: string;
  memory: string;
  vaultHeld: boolean;
  surface: Surface;
  steps: string[];
  finish?: boolean;
  open?: boolean;
  formTask?: boolean;
}): Promise<Decision> {
  const call = modelCall();
  const controls = input.surface.controls.map(controlLine).join("\n");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (call.apiKey) headers.Authorization = `Bearer ${call.apiKey}`;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [
        "You operate one website dock. Reply with JSON only, no markdown.",
        '{"action":"click"|"type"|"select"|"clickAt"|"scroll"|"scrollUp"|"press"|"wait"|"done"|"hold","ref":null,"target":"","text":"","useVault":false,"sensitive":false,"summary":"","reason":""}',
        "Controls are listed as [number] kind: label, with a field's current value after =. To click, type into or select a control, put its number in ref. The number is exact; a label is a guess, and two fields often share one label (a 'from' and a 'to' station box): the numbers tell them apart, and the value shows which is already filled.",
        "After typing into a box that offers suggestions, the suggestions are listed as option controls on the next step: click the right one by its number before moving to the next field.",
        "The page text you are given already includes passages from further down the page that match the task, so scroll only when what you need is not in it.",
        "When you use done, summary is the complete answer for the person who asked: every figure, time, name and date, exactly as shown, in plain text with no Markdown.",
        "Decide the next step yourself. Reply with one step only.",
        "Work out what the task still needs — route, date, direction, how many people, a price, a time — and take the step that fills the biggest gap. Name that gap in reason.",
        "The answer must carry the figures the task asked for, such as a price with its currency or a departure and arrival time. Describing the page is not an answer.",
        "select picks an option from a dropdown: target is the dropdown's label, text is the option to choose.",
        input.surface.image && call.vision
          ? "clickAt clicks a point: target is 'x,y' in pixels of the screenshot, which is 1100 by 720. Use it for custom widgets such as date pickers and time lists that have no usable label."
          : "Use click, type, or select for controls. Do not use clickAt.",
        "If the answer is already on screen, use done and put it in summary. Do not click just to look busy.",
        "A landing page, a route list, or a page of adverts is not an answer. If the page shows no prices, times, or results, fill in its search form or go to its results page before answering.",
        input.formTask
          ? "Results pages follow shapes you can adapt, for example google.com/travel/flights?q=flights%20from%20LHR%20to%20CDG%20on%202026-11-15, kayak.com/flights/LON-PAR/2026-11-15, skyscanner.net/transport/flights/lon/par/261115/, thetrainline.com/book/results?origin=london&destination=manchester&outwardDate=2026-11-15T09:00:00, nationalrail.co.uk. A shape is a guess, so click it as a full URL, then check the page really lists prices or times and use the site's own search form if it does not."
          : "",
        "Never repeat a step that is already listed.",
        "If the goal needs another page, a menu, search, or a banner out of the way, click, scroll, or type. Do not wait for the user to say click.",
        "Controls show '→ URL' when a link has a known address. To follow one reliably, use click with the full URL as target instead of the label.",
        "Use scroll to reveal content below the fold. Use scrollUp to go back up if you overshot.",
        "To search, use action type and put the query in text. Do not open Chat, Ask AI, or voice chat.",
        "Typing fills a box, it does not submit it. After typing into a form field, press Enter or click the search button before expecting the page to change.",
        "Do not guess personal facts. Do not type a name, passport number, date of birth, address, or card number unless that exact fact is written in the task.",
        input.finish
          ? "No more actions. action must be done. summary answers the task from the visible page. Do not claim a click."
          : "",
        "click target is the visible label only. Never include a tag such as a: or button:.",
        "Never invent or repeat a password. If a login is required and a saved login exists, set useVault true and leave text empty.",
        "If the page says it is still loading, searching, or comparing, use wait. Do not hold and do not answer from a half-loaded page.",
        "If the page is a human check, use hold.",
        "Searching, choosing a date or a time, and reading a price are never sensitive. Set sensitive true and use hold only when the step itself pays, sends money, confirms a booking that carries someone's details, deletes something, or changes a password.",
        input.open
          ? "You may leave the start site for any public site the task needs, such as search results. Once there, stay on the sites that answer the task."
          : "Stay on this site.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Task: ${input.task}`,
        `Today: ${dateHint(new Date())}. Work out any date the task gives as a day or a word, such as tomorrow or next Friday, from this one.`,
        `Steps already taken: ${input.steps.length ? input.steps.join(" ") : "(none)"}`,
        `Dock note: ${input.memory || "(none)"}`,
        `Saved login on this host: ${input.vaultHeld ? "yes" : "no"}`,
        `URL: ${input.surface.url}`,
        `Title: ${input.surface.title}`,
        `Page text:\n${focusText(input.surface.text, input.task, TEXT_FOR_MODEL)}`,
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
        `Page text:\n${focusText(input.surface.text, input.task, TEXT_FOR_MODEL + 3000)}`,
      ].join("\n\n"),
    },
  ];
  const jsonMode = !call.url.includes("api.x.ai");
  return complete(call, headers, messages, jsonMode, 800);
}

const ACTIONS: Decision["action"][] = [
  "click",
  "type",
  "select",
  "clickAt",
  "scroll",
  "scrollUp",
  "press",
  "wait",
  "done",
  "hold",
];
// Matched on letters only and without case, so clickAt, clickat and click_at all
// land on the same action — the camelCase names never survived a toLowerCase.
const ACTION_BY_NAME = new Map<string, Decision["action"]>([
  ...ACTIONS.map((action) => [action.toLowerCase(), action] as const),
  ["clickxy", "clickAt"],
  ["clickpoint", "clickAt"],
  ["scrolldown", "scroll"],
  ["scrollback", "scrollUp"],
  ["waitfor", "wait"],
  ["navigate", "click"],
  ["goto", "click"],
  ["open", "click"],
  ["pressenter", "press"],
  ["enter", "press"],
  ["answer", "done"],
  ["finish", "done"],
]);

export function parseDecision(raw: string): Decision {
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
  const named = String(json?.action ?? pick("action") ?? "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  const action = ACTION_BY_NAME.get(named);
  if (!action) {
    throw new Error(`The assistant returned an unknown step: ${named || "(none)"}.`);
  }
  const rawRef = json?.ref ?? slice.match(/"ref"\s*:\s*"?(\d+)"?/i)?.[1];
  const ref = rawRef === null || rawRef === undefined || rawRef === "" ? NaN : Number(rawRef);
  return {
    action,
    ref: Number.isInteger(ref) && ref >= 0 && ref < 1000 ? ref : null,
    target: String(json?.target ?? pick("target")).slice(0, 300),
    text: String(json?.text ?? pick("text")).slice(0, 600),
    useVault: Boolean(json?.useVault),
    sensitive: Boolean(json?.sensitive),
    summary: String(json?.summary ?? pick("summary")).slice(0, 4000),
    reason: String(json?.reason ?? pick("reason")).slice(0, 400),
  };
}

export function isSensitive(decision: Decision): boolean {
  if (decision.useVault && decision.action === "type") return false;
  if (decision.sensitive) return true;
  if (!COMMITTING_ACTIONS.has(decision.action)) return false;
  return SENSITIVE_RE.test(`${decision.target} ${decision.text} ${decision.reason}`);
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
  if (decision.action === "wait") return "Waited for the page to finish loading.";
  if (decision.action === "scroll") return "Scrolled down the page.";
  if (decision.action === "scrollUp") return "Scrolled up the page.";
  if (decision.action === "press") return `Pressed ${KEYS.has(decision.target) ? decision.target : "Enter"}.`;
  if (decision.action === "type" && decision.useVault) return "Used the saved login.";
  if (decision.action === "type" && typeof decision.ref === "number") {
    return `Typed "${decision.text.slice(0, 60)}" into ${decision.target || "field"} [${decision.ref}].`;
  }
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

/** Give a step the name of the control its number points at, so the record reads properly. */
function named(decision: Decision, surface: Surface): Decision {
  if (typeof decision.ref !== "number") return decision;
  const control = surface.controls.find((c) => c.ref === decision.ref);
  if (!control) return { ...decision, ref: null };
  return /^https?:/i.test(decision.target) ? decision : { ...decision, target: control.label };
}

export function isRepeated(label: string, history: Step[]): boolean {
  const same = label.toLowerCase();
  // A step that already failed counts as tried, so it is not retried.
  if (history.some((s) => s.label.startsWith("The action failed: ") && s.label.toLowerCase().includes(same))) return true;
  return history.filter((s) => s.label.toLowerCase() === same).length >= 2;
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

// clickAt coordinates are pixels in the screenshot, which is the viewport size.
export function parsePoint(target: string): { x: number; y: number } {
  const [x, y] = target.split(",").map((part) => Number(part.trim()));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("The click needs x,y in pixels.");
  return {
    x: Math.min(VIEW_W - 1, Math.max(0, x ?? 0)),
    y: Math.min(VIEW_H - 1, Math.max(0, y ?? 0)),
  };
}

/**
 * Wait until the page has stopped changing, not a fixed pause: back at once on
 * a static page, and long enough on one that fills itself in with scripts, so
 * the model is not shown a half-loaded page and made to spend a step waiting.
 */
async function settle(page: PWPage, maxMs = 2500, calmPolls = 2) {
  const started = Date.now();
  let last = -1;
  let calm = 0;
  while (Date.now() - started < maxMs) {
    const size = await page
      .evaluate(() => (document.readyState === "loading" ? -1 : (document.body?.innerText.length ?? 0) + document.querySelectorAll("a,button,input").length))
      .catch(() => -2);
    if (size >= 0 && size === last) {
      calm += 1;
      if (calm >= calmPolls) return;
    } else {
      calm = 0;
    }
    last = size;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

async function perform(dock: ChromeDock, decision: Decision) {
  const page = dock.page;
  const byRef = typeof decision.ref === "number" ? page.locator(`[data-berth-ref="${decision.ref}"]`).first() : null;
  const pointed = byRef && (await byRef.count()) > 0 ? byRef : null;
  if (pointed && !decision.useVault && (decision.action === "click" || decision.action === "type" || decision.action === "select")) {
    if (decision.action === "select") {
      await pointed.selectOption({ label: decision.text }, { timeout: 5000 });
      await settle(page, 3000, 5);
      return;
    }
    if (decision.action === "click" && !/^https?:\/\//i.test(decision.target.trim())) {
      await pointed.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
      await pointed.click({ timeout: 6000 });
      await settle(page, 3000, 5);
      return;
    }
    if (decision.action === "type") {
      const locked = await pointed
        .evaluate((el) => (el as HTMLInputElement).disabled === true || (el as HTMLInputElement).readOnly === true)
        .catch(() => false);
      let field = pointed;
      if (locked) {
        // A box that is greyed out until clicked: click where it sits, then type
        // into whatever takes focus (the journey planners do this).
        const box = await pointed.boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await settle(page);
        }
        const focused = page.locator("input:focus, textarea:focus, [contenteditable='true']:focus").first();
        if ((await focused.count()) > 0) field = focused;
      }
      await field.fill(decision.text, { timeout: 5000 });
      if (needsQuery(page.url())) await field.press("Enter");
      await settle(page, 3000, 5);
      return;
    }
  }
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
      const named = page.getByLabel(target).or(page.getByPlaceholder(target));
      // Some journey planners carry a disabled mirror of the real box, and it comes
      // first in the DOM, so fill() timed out on a field nobody can type into.
      const typeable = page.locator(
        "input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), [contenteditable='true']",
      );
      let field = named.and(typeable).first();
      if ((await field.count()) === 0 && (await named.count()) > 0) {
        // The only match is disabled, which on a journey planner means the box
        // opens a panel when its wrapper is clicked. Click where it sits, then
        // type into whatever takes focus.
        const box = await named.first().boundingBox().catch(() => null);
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await settle(page);
        }
        const focused = page
          .locator("input:focus, textarea:focus, [contenteditable='true']:focus")
          .first();
        field = (await focused.count()) > 0 ? focused : named.first();
      }
      if ((await field.count()) > 0) {
        await field.fill(decision.text, { timeout: 5000 });
        // Filling a named box does not submit it. On a search home that leaves the
        // page exactly as it was, so the next step types the same query again.
        if (needsQuery(page.url())) await field.press("Enter");
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
    const point = parsePoint(decision.target);
    await page.mouse.click(point.x, point.y);
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
      .or(page.getByRole("option", { name }))
      .or(page.getByRole("menuitem", { name }))
      .or(page.getByRole("radio", { name }))
      .or(page.getByLabel(name))
      .or(page.getByPlaceholder(name))
      .or(page.getByText(name, { exact: false }))
      .first();
    await locator.evaluate((el) => el.scrollIntoView({ block: "center" })).catch(() => undefined);
    await locator.click({ timeout: 8000 });
    await settle(page);
  }
}

// A task that has to be filled into a search form — a route, a date, a number of
// people — needs more steps than reading one page, and it is the kind of task that
// lands on a marketing page instead of results.
const FORM_TASK_RE =
  /\b(flight|flights|fly|airline|one[- ]way|return|train|trains|rail|coach|ferry|ticket|tickets|fare|fares|timetable|departures?|arrivals?|hotel|hostel|room|rooms|car hire|car rental|book|booking|from\s+\S+\s+to\s+\S+)\b/i;

// The model has no clock, so "tomorrow" and "next Friday" were guesses — a live
// train run searched today's date for a task that asked for tomorrow.
export function dateHint(now: Date): string {
  const day = now.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${now.toISOString().slice(0, 10)} (${day}, UTC)`;
}

export function needsForm(task: string): boolean {
  return FORM_TASK_RE.test(task);
}

export function needsQuery(url: string): boolean {
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
  /** Give up and answer with what is on the page after this long. */
  deadlineMs?: number;
}): Promise<DockResult> {
  let clean: string;
  try {
    clean = cleanId(input.id);
  } catch (e) {
    return fail(e);
  }
  return enqueueFor(clean, async () => {
    const started = Date.now();
    const allowed = Math.min(Math.max(input.deadlineMs ?? TASK_DEADLINE_MS, 10_000), 600_000);
    let modelCalls = 0;
    let partial = false;
    // Leave room for one last model call to write the answer.
    const outOfTime = () => Date.now() - started > allowed - Math.min(25_000, allowed * 0.3);
    const stamp = (result: DockResult): DockResult =>
      result.ok ? { ...result, summary: plainAnswer(result.summary), metrics: { elapsedMs: Date.now() - started, modelCalls, partial } satisfies TaskMetrics } : result;
    const finish_ = (surface: Surface, extras?: Parameters<typeof viewFrom>[1]) => stamp(viewFrom(surface, extras));
    const ask = (args: Parameters<typeof askModel>[0]) => {
      modelCalls += 1;
      return askModel(args);
    };
    const write = (args: Parameters<typeof answerTask>[0]) => {
      modelCalls += 1;
      return answerTask(args);
    };
    try {
      // 400 cut a caller's task off mid-sentence; a task with form values needs the room.
      const task = input.task.trim().slice(0, 2000);
      const memory = input.memory.trim().slice(0, 400);
      if (!task) throw new Error("Say what you want done.");
      takeTaskSlot();
      pending.delete(clean);
      busy.add(clean);
      globalThis.__berthActiveDockId = clean;
      let dock = await ensure(clean, input.homeUrl, input.currentUrl);
      if (dock.kind === "chrome") await settle(dock.page);
      // An open-web task starts at its search page, even if this dock was left somewhere else.
      const onStart = dock.kind === "chrome" && new URL(dock.page.url() || "about:blank").host === new URL(input.currentUrl).host;
      if (input.open && dock.kind === "chrome" && !onStart) {
        await dock.page.goto(input.currentUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await settle(dock.page);
      }
      const steps: Step[] = [];
      let surface = await capture(dock, input.open);
      // Google answers an automated browser with its "unusual traffic" page. Search elsewhere.
      if (dock.kind === "chrome" && /google\.[a-z.]+\/sorry\//i.test(surface.url)) {
        const elsewhere = searchFallbackUrl(surface.url, task) ?? searchFallbackUrl(input.currentUrl, task);
        if (elsewhere) {
          const next = await assertPublicUrl(elsewhere);
          dock.homeUrl = next.origin;
          await dock.page.goto(next.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
          await settle(dock.page);
          surface = await capture(dock, true);
          steps.push({ label: "Google asked for a human check, so searched with DuckDuckGo instead." });
          emitStep(clean, "Google asked for a human check, so searched with DuckDuckGo instead.");
        }
      }
      if (surface.challenge) {
        emitStep(clean, "The site is asking for a person.");
        return finish_(surface, {
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
      let waits = 0;
      let repeats = 0;
      const formTask = needsForm(task);
      const budget = formTask ? MAX_FORM_MODEL_CALLS : MAX_MODEL_CALLS;
      const missBudget = formTask ? MAX_FORM_MISSES : MAX_MISSES;
      for (let i = 0; i < budget; i += 1) {
        if (outOfTime()) {
          partial = true;
          const label = `Ran out of time after ${Math.round((Date.now() - started) / 1000)}s, so answered from the page as it stood.`;
          console.warn(`[berth] ${clean} ${label} url=${surface.url}`);
          steps.push({ label });
          emitStep(clean, label);
          const summary = await write({ task, surface, steps: steps.map((s) => s.label) });
          return finish_(surface, { vaultHeld: held(clean), steps, summary, status: "ready" });
        }
        let finish = i === budget - 1;
        let decision: Decision;
        try {
          decision = await ask({
            task,
            memory,
            vaultHeld: held(clean),
            surface,
            steps: steps.map((step) => step.label),
            finish,
            open: input.open,
            formTask,
          });
        } catch (error) {
          // One unusable reply should not throw away the steps already taken.
          const why = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 200) : String(error);
          const label = `The step was unusable: ${why} at ${surface.url}`;
          console.warn(`[berth] ${clean} ${label}`);
          misses += 1;
          if (misses < missBudget) {
            steps.push({ label });
            continue;
          }
          const summary = await write({ task, surface, steps: steps.map((step) => step.label) });
          return finish_(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label }],
            summary,
            status: "ready",
          });
        }
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
        decision = named(decision, surface);
        const label = stepLabel(decision);
        if (!forcedSearch && isRepeated(label, steps)) {
          repeats += 1;
          if (repeats <= MAX_REPEATS) {
            // Repeating a step is not a reason to end a task that still has steps
            // and misses left. Say it is already tried and ask again.
            const note = `That step was already tried, so it was skipped: ${label} Something else is needed.`;
            console.warn(`[berth] ${clean} ${note} url=${surface.url}`);
            steps.push({ label: note });
            emitStep(clean, note);
            continue;
          }
          finish = true;
          try {
            decision = await ask({
              task,
              memory,
              vaultHeld: held(clean),
              surface,
              steps: steps.map((step) => step.label),
              finish: true,
              open: input.open,
              formTask,
            });
          } catch {
            // finish means answer from the page, which is what done does.
            decision = { ...decision, action: "done" };
          }
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
          return finish_(surface, {
            vaultHeld: held(clean),
            steps,
            summary: decision.reason || decision.summary || "Paused.",
            status: surface.challenge ? "challenge" : "hold",
            pendingLabel: executable ? pendingLabel(decision) : null,
          });
        }
        if (decision.action === "wait" && !finish) {
          if (waits >= MAX_WAITS) {
            const label = `Stopped waiting after ${(MAX_WAITS * WAIT_MS) / 1000}s.`;
            console.warn(`[berth] ${clean} ${label} url=${surface.url}`);
            steps.push({ label });
            emitStep(clean, label);
            decision = { ...decision, action: "done" };
          } else {
            waits += 1;
            const label = `Waited ${(waits * WAIT_MS) / 1000}s for the page to finish loading.`;
            steps.push({ label });
            emitStep(clean, label);
            await new Promise((r) => setTimeout(r, WAIT_MS));
            surface = await capture(dock, input.open);
            continue;
          }
        }
        steps.push({ label: stepLabel(decision) });
        emitStep(clean, stepLabel(decision));
        if (decision.action === "done" || finish) {
          if (decision.action !== "done" || i === budget - 1) partial = finish && i === budget - 1;
          // The step that decides it is done has already read the page. When it
          // wrote a real answer, use it: one model call for a simple read, not two.
          const own = decision.action === "done" ? decision.summary.trim() : "";
          const usable = own.length >= 60 || (own.length >= 20 && /\d/.test(own));
          const summary = usable ? own : await write({ task, surface, steps: steps.map((s) => s.label) });
          return finish_(surface, {
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
          return finish_(surface, {
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
        if (clickMissed && decision.action === "click" && COOKIE_RE.test(decision.target.trim())) {
          // The engine dismisses banners itself, so the model's own click can land
          // after the banner is gone. That is not a miss worth spending.
          surface = await capture(dock, input.open);
          if (!hasCookieBanner(surface)) {
            const label = "The cookie banner was already gone.";
            steps.push({ label });
            emitStep(clean, label);
            continue;
          }
        }
        if (clickMissed) {
          // A failure line names the action, the error and the page, so the model
          // and the log both say what missed and where.
          const missed =
            `The action failed: ${stepLabel(decision)} ${missReason || "no error reported"}` +
            ` at ${dock.page.url()}. Try another way: a different label, the select action for a` +
            ` dropdown, a full URL as the target, or clickAt on the screenshot if one is shown.`;
          console.warn(`[berth] ${clean} ${missed}`);
          misses += 1;
          if (misses < missBudget) {
            // Give the model the failure and let it choose again.
            steps.push({ label: missed });
            surface = await capture(dock, input.open);
            continue;
          }
          surface = await capture(dock, input.open);
          partial = true;
          console.warn(`[berth] ${clean} Gave up after ${missBudget} failed actions. url=${surface.url}`);
          const summary = await write({ task, surface, steps: steps.map((s) => s.label) });
          return finish_(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: missed }, { label: `Gave up after ${missBudget} failed actions.` }],
            summary,
            status: "ready",
          });
        }
        await followNewTab(dock);
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
          return finish_(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: left }],
            summary: left,
            status: "hold",
          });
        }
        if (surface.challenge) {
          return finish_(surface, {
            vaultHeld: held(clean),
            steps: [...steps, { label: "The site is asking for a person." }],
            summary: "Solve the check on the view, then continue.",
            status: "challenge",
          });
        }
      }
      partial = true;
      const capped = `Ran out of steps after ${budget} model calls.`;
      console.warn(`[berth] ${clean} ${capped} url=${dock.kind === "chrome" ? dock.page.url() : dock.url}`);
      const summary = await write({ task, surface, steps: steps.map((s) => s.label) });
      return finish_(surface, {
        vaultHeld: held(clean),
        steps: [...steps, { label: capped }, { label: "Answered from the page." }],
        summary,
        status: "ready",
      });
    } catch (error) {
      return fail(error);
    } finally {
      busy.delete(clean);
      const used = docks.get(clean);
      if (used) used.touched = Date.now();
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

/** Test hooks. Not used by the app. */
export const __test = {
  async crash(id: string) {
    const dock = docks.get(id);
    if (dock?.kind === "chrome") await dock.page.close().catch(() => undefined);
  },
};
