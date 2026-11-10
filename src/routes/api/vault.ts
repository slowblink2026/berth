import { createFileRoute } from "@tanstack/react-router";
import { authorized } from "@/lib/berth/auth.server";

const denied = () => Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
const bad = (error: unknown) =>
  Response.json(
    { ok: false, error: error instanceof Error ? error.message : "The vault failed." },
    { status: 400 },
  );

/**
 * Saved website logins. Passwords go in and never come out: GET lists sites
 * and usernames only.
 */
export const Route = createFileRoute("/api/vault")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!authorized(request)) return denied();
        const vault = await import("@/lib/berth/vault.server");
        return Response.json(
          { ok: true, logins: vault.listLogins() },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
      POST: async ({ request }) => {
        if (!authorized(request)) return denied();
        const body = (await request.json().catch(() => null)) as {
          site?: unknown;
          username?: unknown;
          password?: unknown;
        } | null;
        try {
          const vault = await import("@/lib/berth/vault.server");
          const saved = vault.saveLogin(
            typeof body?.site === "string" ? body.site : "",
            typeof body?.username === "string" ? body.username : "",
            typeof body?.password === "string" ? body.password : "",
          );
          return Response.json(
            { ok: true, login: saved },
            { headers: { "Cache-Control": "no-store" } },
          );
        } catch (error) {
          return bad(error);
        }
      },
      DELETE: async ({ request }) => {
        if (!authorized(request)) return denied();
        try {
          const vault = await import("@/lib/berth/vault.server");
          const removed = vault.removeLogin(new URL(request.url).searchParams.get("site") ?? "");
          return Response.json({ ok: true, removed });
        } catch (error) {
          return bad(error);
        }
      },
    },
  },
});
