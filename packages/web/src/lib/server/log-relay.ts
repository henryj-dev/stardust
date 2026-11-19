/**
 * Relays the API's answer for a build log to the browser, so the browser
 * never holds the token: the log as plain text, or the API's status and
 * reason (409 not started, 410 cleaned up, 404 unknown or off).
 */
export async function relayLog(upstream: Response): Promise<Response> {
  if (upstream.ok && upstream.body) {
    return new Response(headersFirst(upstream.body), {
      headers: {
        // Text, never HTML, and never sniffed into something else.
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
        // An nginx in front (an edge proxy) would otherwise hold the stream back until its buffer fills.
        "x-accel-buffering": "no",
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

/**
 * The body, led by an empty chunk. SvelteKit's Node adapter calls writeHead but
 * Node sends the headers only with the first write, so a log that prints
 * nothing yet (a quiet pod, a build waiting for its first step) kept the
 * browser on "connecting" until it did. Writing an empty chunk sends them.
 */
function headersFirst(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(0));
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
