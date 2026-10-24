import { createFileRoute } from "@tanstack/react-router";
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

function localRequest(request: Request) {
  const host = request.headers.get("host") ?? "";
  return host.startsWith("127.0.0.1:") || host === "127.0.0.1" || host.startsWith("localhost:");
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

async function run(request: Request, url: string, task: string) {
  if (!localRequest(request)) {
    return Response.json({ ok: false, error: "Curl the VPS at 127.0.0.1, not from the phone." }, { status: 403 });
  }
  const homeUrl = normalizeUrl(url);
  const job = task.trim();
  if (!homeUrl || !job) {
    return Response.json({ ok: false, error: "Send a url and a task." }, { status: 400 });
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
  });
  return reply(result);
}

export const Route = createFileRoute("/api/task")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const params = new URL(request.url).searchParams;
        return run(request, params.get("url") ?? "", params.get("task") ?? "");
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as { url?: unknown; task?: unknown } | null;
        return run(request, typeof body?.url === "string" ? body.url : "", typeof body?.task === "string" ? body.task : "");
      },
    },
  },
});
