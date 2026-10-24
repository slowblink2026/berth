import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/watch")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        if (!id) return new Response("Missing id", { status: 400 });
        const mod = await import("@/lib/berth/engine.server");
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const unsub = mod.subscribeSteps(id, (label) => {
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ label })}\n\n`));
              } catch {
                unsub();
              }
            });
            request.signal.addEventListener("abort", () => {
              unsub();
              try { controller.close(); } catch { /* already closed */ }
            });
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      },
    },
  },
});
