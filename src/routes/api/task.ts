import { createFileRoute } from "@tanstack/react-router";
import { authorized } from "@/lib/berth/auth.server";
import type { DockResult } from "@/lib/berth/types";

function dockId(hostname: string) {
  const host = hostname.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `curl${host || "site"}`.slice(0, 80);
}

function normalizeUrl(raw: string) {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function reply(result: DockResult) {
  if (!result.ok) return Response.json(result, { status: 400 });
  return Response.json({
    ok: true,
    status: result.status,
    engine: result.surface.engine,
    url: result.surface.url,
    title: result.surface.title,
    summary: result.summary,
    steps: result.steps.map((step) => step.label),
    pending: result.pendingLabel,
    // How long it took, how many model calls it cost, and whether it ran out of
    // time or steps and answered with what it had.
    elapsed_ms: result.metrics?.elapsedMs ?? null,
    model_calls: result.metrics?.modelCalls ?? null,
    partial: result.metrics?.partial ?? false,
  });
}

// Without a url, a task starts at this search page and may follow results to other public sites.
const SEARCH_START = "https://duckduckgo.com/";

function limit(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

async function run(request: Request, url: string, task: string, timeoutMs?: number, approved = false) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const given = normalizeUrl(url);
  const homeUrl = given || SEARCH_START;
  const job = task.trim();
  if (!job) {
    return Response.json({ ok: false, error: "Send a task, and optionally a url." }, { status: 400 });
  }
  let parsed: URL;
  try {
    parsed = new URL(homeUrl);
  } catch {
    return Response.json({ ok: false, error: "That address isn't a usable URL." }, { status: 400 });
  }
  const mod = await import("@/lib/berth/engine.server");
  const result = await mod.runTask({
    id: dockId(parsed.hostname),
    homeUrl,
    currentUrl: homeUrl,
    task: job,
    memory: "",
    open: !given,
    deadlineMs: timeoutMs,
    approved,
  });
  return reply(result);
}

async function approve(request: Request, url: string) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const homeUrl = normalizeUrl(url) || SEARCH_START;
  let parsed: URL;
  try {
    parsed = new URL(homeUrl);
  } catch {
    return Response.json({ ok: false, error: "That address isn't a usable URL." }, { status: 400 });
  }
  const mod = await import("@/lib/berth/engine.server");
  const result = await mod.gesture({
    id: dockId(parsed.hostname),
    homeUrl,
    currentUrl: homeUrl,
    kind: "approve",
  });
  return reply(result);
}

export const Route = createFileRoute("/api/task")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        if (params.get("approve") === "1") {
          return approve(request, params.get("url") ?? "");
        }
        return run(request, params.get("url") ?? "", params.get("task") ?? "", limit(params.get("timeout_ms")));
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          task?: unknown;
          approve?: unknown;
          timeout_ms?: unknown;
          approved?: unknown;
        } | null;
        if (body?.approve === true) {
          return approve(request, typeof body?.url === "string" ? body.url : "");
        }
        return run(
          request,
          typeof body?.url === "string" ? body.url : "",
          typeof body?.task === "string" ? body.task : "",
          limit(body?.timeout_ms),
          // Set by a caller whose own user has approved this exact task. POST only.
          body?.approved === true,
        );
      },
    },
  },
});
