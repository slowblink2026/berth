import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { env } from "@/lib/env.server";
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

function authorized(request: Request): boolean {
  const apiKey = env("BERTH_API_KEY");
  if (!apiKey) {
    // No key configured — fall back to localhost-only
    const host = request.headers.get("host") ?? "";
    return host.startsWith("127.0.0.1:") || host === "127.0.0.1" || host.startsWith("localhost:");
  }
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${apiKey}`);
  // Constant-time, so the key can't be guessed a character at a time from response timing.
  return given.length === wanted.length && timingSafeEqual(given, wanted);
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

type Limits = { timeoutMs?: number; maxSteps?: number };

function limit(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

async function run(request: Request, url: string, task: string, limits: Limits = {}) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
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
    shots: false,
    deadlineMs: limits.timeoutMs,
    maxSteps: limits.maxSteps,
  });
  return reply(result);
}

async function approve(request: Request, url: string) {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  const homeUrl = normalizeUrl(url);
  if (!homeUrl) {
    return Response.json({ ok: false, error: "Send a url." }, { status: 400 });
  }
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
        return run(request, params.get("url") ?? "", params.get("task") ?? "", {
          timeoutMs: limit(params.get("timeout_ms")),
          maxSteps: limit(params.get("max_steps")),
        });
      },
      POST: async ({ request }) => {
        const body = (await request.json().catch(() => null)) as {
          url?: unknown;
          task?: unknown;
          approve?: unknown;
          timeout_ms?: unknown;
          max_steps?: unknown;
        } | null;
        if (body?.approve === true) {
          return approve(request, typeof body?.url === "string" ? body.url : "");
        }
        return run(
          request,
          typeof body?.url === "string" ? body.url : "",
          typeof body?.task === "string" ? body.task : "",
          { timeoutMs: limit(body?.timeout_ms), maxSteps: limit(body?.max_steps) },
        );
      },
    },
  },
});
