<script lang="ts">
import type { RunView } from "@stardust/sdk";
import JobLog from "$lib/components/JobLog.svelte";
import { duration, isActive, jobFacts, keptLogTail } from "$lib/run-view";

let { data } = $props();
// The newest copy from the live events, until the page loads another run.
let latest = $state<RunView | null>(null);
const run = $derived(latest?.id === data.run.id ? latest : data.run);
let live = $state(false);
let now = $state(Date.now());

// The project's run events carry every run; this page keeps its own.
$effect(() => {
  const source = new EventSource(`/projects/${encodeURIComponent(data.projectId)}/events`);
  const take = (candidate: RunView | undefined) => {
    if (candidate?.id === data.run.id) latest = candidate;
  };
  source.addEventListener("open", () => (live = true));
  source.addEventListener("error", () => (live = false));
  source.addEventListener("runs-snapshot", (e) => {
    take((JSON.parse((e as MessageEvent).data) as RunView[]).find((r) => r.id === data.run.id));
  });
  source.addEventListener("runs-delta", (e) => take(JSON.parse((e as MessageEvent).data) as RunView));
  return () => source.close();
});

// Running jobs' durations count up.
$effect(() => {
  const timer = setInterval(() => (now = Date.now()), 1_000);
  return () => clearInterval(timer);
});

const projectHref = $derived(`/projects/${encodeURIComponent(data.projectId)}`);
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
</script>

<svelte:head>
  <title>Run {run.sha.slice(0, 7)} · {data.projectId} · stardust</title>
</svelte:head>

<main>
  <p><a href={projectHref}>← {data.projectId}</a></p>
  <h1>Run <code>{run.sha.slice(0, 7)}</code></h1>
  <p data-live={live}>{live ? "Live" : "Connecting…"}</p>
  <dl data-run={run.id} data-status={run.status}>
    <dt>Status</dt>
    <dd data-run-status>{run.status}</dd>
    <dt>Ref</dt>
    <dd>{run.ref}</dd>
    <dt>Commit</dt>
    <dd><code>{run.sha}</code></dd>
    <dt>Pulled by</dt>
    <dd>{run.requestedBy ?? "—"}</dd>
    <dt>Started</dt>
    <dd>{time(run.createdAt)}</dd>
    <dt>Finished</dt>
    <dd>{time(run.finishedAt)}</dd>
  </dl>

  {#each run.jobs as job (job.name)}
    <section data-job={job.name} data-status={job.status}>
      <h2>{job.name}: <span data-job-status>{job.status}</span></h2>
      <dl>
        <dt>Attempt</dt>
        <dd>{job.attempt}</dd>
        <dt>Started</dt>
        <dd>{time(job.startedAt)}</dd>
        <dt>Finished</dt>
        <dd>{time(job.finishedAt)}</dd>
        <dt>Duration</dt>
        <dd data-duration>{duration(job.startedAt, job.finishedAt, now) ?? "—"}</dd>
        {#each jobFacts(job.detail) as fact (fact.key)}
          <dt>{fact.label}</dt>
          <dd data-fact={fact.key}>
            {#if fact.key === "reason"}<strong>{fact.value}</strong>{:else}<code>{fact.value}</code>{/if}
          </dd>
        {/each}
      </dl>
      {#if job.status !== "skipped" && job.status !== "cancelled"}
        <JobLog projectId={data.projectId} runId={run.id} name={job.name} status={job.status} />
      {/if}
      {#if keptLogTail(job.detail) && !isActive(job.status)}
        <details data-kept-tail>
          <summary>Last lines kept when the build failed</summary>
          <pre>{keptLogTail(job.detail)}</pre>
        </details>
      {/if}
    </section>
  {:else}
    <p>This run has no jobs.</p>
  {/each}
</main>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  pre {
    max-height: 20rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
