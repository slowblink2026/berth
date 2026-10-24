import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/active")({
  server: {
    handlers: {
      GET: async () => {
        const mod = await import("@/lib/berth/engine.server");
        const id = mod.getActiveDockId();
        return new Response(JSON.stringify({ id }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
