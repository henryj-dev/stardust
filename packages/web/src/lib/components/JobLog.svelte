<script lang="ts">
import { untrack } from "svelte";
import { followLog, type LogState } from "$lib/run-log";
import { isActive } from "$lib/run-view";

let { projectId, runId, name, status }: { projectId: string; runId: string; name: string; status: string } = $props();

// The browser keeps the end of a very long log.
const MAX_CHARS = 1_000_000;
let text = $state("");
let logState = $state<LogState>({ kind: "connecting" });
let box = $state<HTMLPreElement | null>(null);

$effect(() => {
  const url = `/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(name)}/log`;
  const stop = new AbortController();
  untrack(() => {
    void followLog({
      url,
      active: () => isActive(status),
      onReset: () => {
        text = "";
      },
      onText: (chunk) => {
        if (!chunk) return;
        // Follow the end only when the reader is already there.
        const atEnd = box ? box.scrollHeight - box.scrollTop - box.clientHeight < 40 : true;
        const next = text + chunk;
        text = next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next;
        if (atEnd) queueMicrotask(() => box?.scrollTo({ top: box.scrollHeight }));
      },
      onState: (s) => {
        logState = s;
      },
      signal: stop.signal,
    });
  });
  return () => stop.abort();
});

const note = $derived(
  logState.kind === "connecting"
    ? "Connecting…"
    : logState.kind === "waiting"
      ? "Waiting for the build to start printing…"
      : logState.kind === "streaming"
        ? isActive(status)
          ? "Live"
          : "Complete"
        : logState.kind === "ended"
          ? text
            ? "Complete"
            : "The build printed nothing."
          : logState.message,
);
</script>

<section data-log={name} data-log-state={logState.kind}>
  <h3>Build log</h3>
  <p data-log-note role={logState.kind === "error" ? "alert" : undefined}>{note}</p>
  {#if text}
    <!-- A text node: the log is shown as printed, never interpreted as HTML. -->
    <pre bind:this={box} data-log-text>{text}</pre>
  {/if}
</section>

<style>
  pre {
    max-height: 32rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
