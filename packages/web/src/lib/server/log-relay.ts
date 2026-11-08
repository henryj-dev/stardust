/**
 * Relays the API's answer for a build log to the browser, so the browser
 * never holds the token: the log as plain text, or the API's status and
 * reason (409 not started, 410 cleaned up, 404 unknown or off).
 */
export async function relayLog(upstream: Response): Promise<Response> {
  if (upstream.ok && upstream.body) {
    return new Response(upstream.body, {
      headers: {
        // Text, never HTML, and never sniffed into something else.
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    });
  }
  const body = (await upstream.json().catch(() => null)) as { error?: unknown } | null;
  const error = typeof body?.error === "string" ? body.error : `the log could not be read (${upstream.status})`;
  return Response.json(
    { error },
    { status: upstream.ok ? 502 : upstream.status, headers: { "cache-control": "no-store" } },
  );
}
