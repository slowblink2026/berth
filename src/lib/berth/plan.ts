/** Pure helpers for the task loop: reading the model's step, choosing what text
 *  it sees, and deciding what not to load. No browser, no network: unit tested. */

export const ACTIONS = ["click", "type", "select", "scroll", "scrollUp", "press", "wait", "done", "hold"] as const;

export type Decision = {
  action: (typeof ACTIONS)[number];
  /** The [number] of a control from the list the model was shown, when it used one. */
  ref: number | null;
  target: string;
  text: string;
  /** After typing, press Enter (a search box, a one-field form). */
  submit: boolean;
  useVault: boolean;
  sensitive: boolean;
  summary: string;
  reason: string;
};

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
    const match = slice.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, "i"));
    return match?.[1] ?? "";
  };
  const wanted = String(json?.action ?? pick("action") ?? "").trim();
  const action = ACTIONS.find((name) => name.toLowerCase() === wanted.toLowerCase());
  if (!action) throw new Error("The assistant returned an unknown step.");
  const rawRef = json?.ref ?? slice.match(/"ref"\s*:\s*"?(\d+)"?/i)?.[1];
  const ref = rawRef === null || rawRef === undefined || rawRef === "" ? NaN : Number(rawRef);
  return {
    action,
    ref: Number.isInteger(ref) && ref >= 0 && ref < 1000 ? ref : null,
    target: String(json?.target ?? pick("target")).slice(0, 300),
    text: String(json?.text ?? pick("text")).slice(0, 600),
    submit: json?.submit === true,
    useVault: Boolean(json?.useVault),
    sensitive: Boolean(json?.sensitive),
    summary: String(json?.summary ?? pick("summary")).slice(0, 4000),
    reason: String(json?.reason ?? pick("reason")).slice(0, 400),
  };
}

const STOP = new Set(
  ("the a an and or of to in on for from with at by is are was were be this that these those it its as into " +
    "what which who when where how find read open page report tell show give get check search public web answer " +
    "available current please using use any all your you me my").split(" "),
);

export function taskTerms(task: string): string[] {
  const seen = new Set<string>();
  for (const word of task.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.'£$€%-]{1,}/gu) ?? []) {
    const clean = word.replace(/[.'-]+$/, "");
    if (clean.length > 2 && !STOP.has(clean)) seen.add(clean);
  }
  return [...seen].slice(0, 24);
}

/**
 * The part of a long page worth showing the model. The top of the page always
 * goes in; the rest of the room goes to the passages that mention the task's
 * own words, in page order, so an answer far below the fold is not cut off.
 */
export function focusText(text: string, task: string, limit: number): string {
  if (text.length <= limit) return text;
  const headRoom = Math.floor(limit * 0.45);
  const head = text.slice(0, headRoom);
  const terms = taskTerms(task);
  if (!terms.length) return text.slice(0, limit);
  const rest = text.slice(headRoom);
  const blocks: { at: number; body: string; score: number }[] = [];
  let at = 0;
  for (const body of rest.split(/\n{1,}/)) {
    const lower = body.toLowerCase();
    const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
    if (body.trim()) blocks.push({ at, body: body.trim().slice(0, 600), score });
    at += 1;
  }
  const keep = new Set<number>();
  let room = limit - headRoom - 40;
  for (const block of [...blocks].sort((a, b) => b.score - a.score || a.at - b.at)) {
    if (block.score === 0 || room <= 0) break;
    if (block.body.length + 1 > room) continue;
    keep.add(block.at);
    room -= block.body.length + 1;
  }
  if (!keep.size) return text.slice(0, limit);
  const tail = blocks
    .filter((block) => keep.has(block.at))
    .map((block) => block.body)
    .join("\n");
  return `${head}\n[… further down the page …]\n${tail}`;
}

const TRACKERS = [
  "doubleclick.net", "googlesyndication.com", "googletagmanager.com", "google-analytics.com", "googleadservices.com",
  "adservice.google.com", "facebook.net", "connect.facebook.net", "scorecardresearch.com", "quantserve.com",
  "hotjar.com", "segment.io", "segment.com", "mixpanel.com", "amplitude.com", "criteo.com", "criteo.net",
  "taboola.com", "outbrain.com", "adnxs.com", "rubiconproject.com", "pubmatic.com", "openx.net", "moatads.com",
  "chartbeat.com", "newrelic.com", "nr-data.net", "optimizely.com", "branch.io", "adsrvr.org", "amazon-adsystem.com",
  "bing.com/bat", "clarity.ms", "fullstory.com", "krxd.net", "bluekai.com", "casalemedia.com", "3lift.com",
];

export function isTrackerHost(host: string): boolean {
  const lower = host.toLowerCase();
  return TRACKERS.some((name) => lower === name || lower.endsWith(`.${name}`));
}

/**
 * A search engine that answers an automated browser with a human check has a
 * plain-HTML alternative that doesn't. Returns its URL for the same query, or
 * null when the blocked page was not a search.
 */
export function searchFallbackUrl(blockedUrl: string, task: string): string | null {
  let url: URL;
  try {
    url = new URL(blockedUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  const isSearch = /(^|\.)google\.[a-z.]+$/.test(host) || /(^|\.)bing\.com$/.test(host) || host === "search.yahoo.com";
  if (!isSearch) return null;
  let query = url.searchParams.get("q") || url.searchParams.get("p") || "";
  const forwarded = url.searchParams.get("continue") || url.searchParams.get("url");
  if (!query && forwarded) {
    try {
      query = new URL(forwarded).searchParams.get("q") ?? "";
    } catch {
      query = "";
    }
  }
  if (!query) query = taskTerms(task).slice(0, 10).join(" ");
  if (!query) return null;
  return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

/** Markdown the model adds to an answer, taken out: callers show it as plain text. */
export function plainAnswer(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, "$1")
    .replace(/^(\s*)[*-]\s+/gm, "$1• ")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
