/**
 * Follows a job's build log from the dashboard's own log route: streams it
 * while the build prints, waits while the build has not started, and stops
 * when the job is over or the log is gone. Text only — callers render it as
 * a text node, never as HTML.
 */

export type LogState =
  | { kind: "connecting" }
  | { kind: "waiting" }
  | { kind: "streaming" }
  | { kind: "ended" }
  | { kind: "gone"; message: string }
  | { kind: "error"; message: string };

export interface FollowOptions {
  /** The log route, without a query. */
  url: string;
  /** Whether the job may still print: then the log is followed and retried. */
  active: () => boolean;
  /** A fresh copy of the log starts: drop what was shown. */
  onReset: () => void;
  onText: (text: string) => void;
  onState: (state: LogState) => void;
  signal: AbortSignal;
  fetch?: typeof fetch;
  retryMs?: number;
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const errorOf = async (res: Response) => {
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
  return body?.error ?? body?.message ?? `the log could not be read (${res.status})`;
};

export async function followLog(options: FollowOptions): Promise<void> {
  const { signal } = options;
  const doFetch = options.fetch ?? fetch;
  const retryMs = options.retryMs ?? 3_000;
  options.onState({ kind: "connecting" });
  while (!signal.aborted) {
    const active = options.active();
    let res: Response;
    try {
      res = await doFetch(active ? `${options.url}?follow=true` : options.url, { signal });
    } catch {
      if (signal.aborted) return;
      options.onState({ kind: "error", message: "the log could not be reached; retrying" });
      await wait(retryMs, signal);
      continue;
    }
    if (res.ok && res.body) {
      options.onReset();
      options.onState({ kind: "streaming" });
      const decoder = new TextDecoder();
      try {
        for await (const chunk of res.body) options.onText(decoder.decode(chunk, { stream: true }));
        options.onText(decoder.decode());
      } catch {
        if (signal.aborted) return;
      }
      // The pod's log ended: the build finished, or the next attempt is starting.
      if (!options.active()) {
        options.onState({ kind: "ended" });
        return;
      }
    } else if (res.status === 409) {
      if (!active) {
        options.onState({ kind: "ended" });
        return;
      }
      options.onState({ kind: "waiting" });
    } else if (res.status === 410) {
      options.onState({ kind: "gone", message: await errorOf(res) });
      return;
    } else {
      options.onState({ kind: "error", message: await errorOf(res) });
      return;
    }
    await wait(retryMs, signal);
  }
}
