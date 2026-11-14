<script lang="ts">
import { untrack } from "svelte";
import { followLog, type LogState } from "$lib/run-log";

let { data } = $props();
const MAX_CHARS = 1_000_000;
let text = $state("");
let logState = $state<LogState>({ kind: "connecting" });
let box = $state<HTMLPreElement | null>(null);
const p = (s: string) => encodeURIComponent(s);
const componentHref = $derived(`/projects/${p(data.projectId)}/components/${p(data.component)}`);

$effect(() => {
  const query = new URLSearchParams({ source: data.source, ...(data.container ? { container: data.container } : {}) });
  const url = `${componentHref}/pods/${p(data.pod)}/log?${query}`;
  const stop = new AbortController();
  untrack(() => {
    void followLog({
      url,
      // A live pod's log is followed; a kept one is read once.
      active: () => data.source === "live",
      onReset: () => {
        text = "";
      },
      onText: (chunk) => {
        if (!chunk) return;
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
</script>

<svelte:head>
  <title>{data.pod} · {data.component} · stardust</title>
</svelte:head>

<main>
  <p><a href={componentHref}>← {data.component}</a></p>
  <h1><code>{data.pod}</code></h1>
  <p>
    {#if data.source === "live"}
      Live log · <a href={`?source=history${data.container ? `&container=${p(data.container)}` : ""}`}>kept log</a>
    {:else}
      Kept log · <a href={`?source=live${data.container ? `&container=${p(data.container)}` : ""}`}>live log</a>
    {/if}
  </p>
  <p data-log-note role={logState.kind === "error" || logState.kind === "gone" ? "alert" : undefined}>
    {logState.kind === "error" || logState.kind === "gone" ? logState.message : logState.kind === "streaming" ? "Streaming" : logState.kind === "ended" ? (text ? "End of log" : "The log is empty.") : "Connecting…"}
  </p>
  {#if text}
    <!-- A text node: the log is shown as printed, never interpreted as HTML. -->
    <pre bind:this={box} data-log-text>{text}</pre>
  {/if}
</main>

<style>
  pre {
    max-height: 40rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
