import { env } from "@/lib/env.server";

/**
 * One gate for every Berth HTTP route. With BERTH_API_KEY set, a request needs
 * the bearer token; without a key, only localhost can call in.
 */
export function authorized(request: Request): boolean {
  const apiKey = env("BERTH_API_KEY");
  if (!apiKey) {
    // No key configured — fall back to localhost-only
    const host = request.headers.get("host") ?? "";
    return host.startsWith("127.0.0.1:") || host === "127.0.0.1" || host.startsWith("localhost:");
  }
  const auth = request.headers.get("authorization") ?? "";
  return auth === `Bearer ${apiKey}`;
}
