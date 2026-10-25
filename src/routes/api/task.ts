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
  });
}

// Without a url, a task starts at this search page and may follow results to other public sites.
const SEARCH_START = "https://duckduckgo.com/";

async function run(request: Request, url: string, task: string) {
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
        return run(request, params.get("url") ?? "", params.get("task") ?? "");
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          task?: unknown;
          approve?: unknown;
        } | null;
        if (body?.approve === true) {
          return approve(request, typeof body?.url === "string" ? body.url : "");
        }
        return run(
          request,
          typeof body?.url === "string" ? body.url : "",
          typeof body?.task === "string" ? body.task : "",
        );
      },
    },
  },
});
