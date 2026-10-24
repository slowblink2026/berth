import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/screenshot")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!id) return new Response("Missing id", { status: 400 });
        const mod = await import("@/lib/berth/engine.server");
        const buf = await mod.captureScreenshot(id);
        if (!buf) return new Response("No screenshot available", { status: 404 });
        return new Response(buf, {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
