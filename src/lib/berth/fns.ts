import { createServerFn } from "@tanstack/react-start";
import type { DockResult } from "@/lib/berth/types";

async function engine() {
  return import("./engine.server");
}

function readCommon(input: unknown): { id: string; homeUrl: string; currentUrl: string } {
  if (!input || typeof input !== "object") throw new Error("Missing dock.");
  const row = input as { id?: unknown; homeUrl?: unknown; currentUrl?: unknown };
  if (typeof row.id !== "string" || typeof row.homeUrl !== "string") throw new Error("Missing dock.");
  const currentUrl = typeof row.currentUrl === "string" && row.currentUrl ? row.currentUrl : row.homeUrl;
  return { id: row.id, homeUrl: row.homeUrl, currentUrl };
}

export const viewDock = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<DockResult> => {
    try {
      const common = readCommon(data);
      const mod = await engine();
      return mod.viewDock(common.id, common.homeUrl, common.currentUrl);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The dock failed." };
    }
  });

export const runDockTask = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<DockResult> => {
    try {
      const common = readCommon(data);
      const row = data as { task?: unknown; memory?: unknown };
      const mod = await engine();
      return mod.runTask({
        ...common,
        task: typeof row.task === "string" ? row.task : "",
        memory: typeof row.memory === "string" ? row.memory : "",
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The dock failed." };
    }
  });

export const dockGesture = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }): Promise<DockResult> => {
    try {
      const common = readCommon(data);
      const row = data as { kind?: unknown; x?: unknown; y?: unknown; text?: unknown; href?: unknown };
      const kind = row.kind;
      if (
        kind !== "click" &&
        kind !== "type" &&
        kind !== "follow" &&
        kind !== "approve" &&
        kind !== "dismiss" &&
        kind !== "refresh"
      ) {
        throw new Error("Unknown gesture.");
      }
      const mod = await engine();
      return mod.gesture({
        ...common,
        kind,
        x: typeof row.x === "number" ? row.x : undefined,
        y: typeof row.y === "number" ? row.y : undefined,
        text: typeof row.text === "string" ? row.text : undefined,
        href: typeof row.href === "string" ? row.href : undefined,
      });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "The dock failed." };
    }
  });

export const keepSecret = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    try {
      const row = data as { id?: unknown; secret?: unknown };
      if (typeof row.id !== "string") throw new Error("Missing dock.");
      const mod = await engine();
      return mod.setSecret(row.id, typeof row.secret === "string" ? row.secret : "");
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "The vault failed." };
    }
  });

export const releaseDock = createServerFn({ method: "POST" })
  .validator((input: unknown) => input)
  .handler(async ({ data }) => {
    try {
      const row = data as { id?: unknown };
      if (typeof row.id !== "string") throw new Error("Missing dock.");
      const mod = await engine();
      return mod.closeDock(row.id);
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : "The dock failed." };
    }
  });
