/**
 * Relays the API's answer for a log (a build's or a pod's) to the browser, so
 * the browser never holds the token.
 *
 * A followed log is live, so it goes out as server-sent events, like the
 * project's event stream: `event: log` with the text as a JSON string (newlines
 * and every character kept), a `: heartbeat` comment every few seconds, and
 * `event: end` when the API's log ends. The heartbeat keeps a proxy in front
 * from closing a quiet stream (nginx gives up after 60 s without a byte), and
 * the first one sends the headers at once: SvelteKit's Node adapter sends them
 * only with the first write.
 *
 * A log read once (not followed, or a kept log) stays plain text. Either way an
 * answer that is not a log keeps the API's status and reason (409 not started,
 * 410 cleaned up, 404 unknown or off).
 */

export const HEARTBEAT_MS = 5_000;

export interface RelayOptions {
  /** The browser asked to follow the log: answer with events. */
  follow?: boolean;
  /** For tests. */
  heartbeatMs?: number;
}

export async function relayLog(upstream: Response, options: RelayOptions = {}): Promise<Response> {
  if (upstream.ok && upstream.body) {
    if (options.follow) {
      return new Response(logEvents(upstream.body, options.heartbeatMs ?? HEARTBEAT_MS), {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          // An nginx in front would otherwise hold the stream back until its buffer fills.
          "x-accel-buffering": "no",
        },
      });
    }
    return new Response(upstream.body, {
      headers: {
        // Text, never HTML, and never sniffed into something else.
        "content-type": "text/plain; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
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

const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(": heartbeat\n\n");
const event = (name: string, data: unknown) => encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

/** The log's bytes as `log` events, with a heartbeat while it is quiet and `end` when it ends. */
function logEvents(body: ReadableStream<Uint8Array>, heartbeatMs: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(HEARTBEAT);
      timer = setInterval(() => {
        try {
          controller.enqueue(HEARTBEAT);
        } catch {
          clearInterval(timer);
        }
      }, heartbeatMs);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (!done) {
          // stream: true keeps a character split across two chunks whole.
          const text = decoder.decode(value, { stream: true });
          if (text) controller.enqueue(event("log", text));
          return;
        }
        const rest = decoder.decode();
        if (rest) controller.enqueue(event("log", rest));
        controller.enqueue(event("end", {}));
      } catch {
        // The API or the cluster dropped the log: say so, and let the page retry.
        controller.enqueue(event("end", { error: "the log stream broke off" }));
      }
      clearInterval(timer);
      controller.close();
    },
    cancel(reason) {
      clearInterval(timer);
      return reader.cancel(reason);
    },
  });
}
