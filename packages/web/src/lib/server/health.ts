/**
 * The health check: a 200 that depends on nothing but this process serving
 * requests. Probes and proxies use it; every other page needs a session or
 * redirects to sign in, and a 303 reads as "down" to most health checkers.
 */
export const HEALTH_PATH = "/healthz";

/** True for the health check path, which skips session handling (no API call). */
export function isHealthCheck(pathname: string): boolean {
  return pathname === HEALTH_PATH;
}

export function healthResponse(method: "GET" | "HEAD"): Response {
  return new Response(method === "HEAD" ? null : "ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
