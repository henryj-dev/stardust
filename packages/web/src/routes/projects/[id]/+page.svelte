<script lang="ts">
import type { RunView } from "@stardust/sdk";

let { data, form } = $props();
let runs = $state<RunView[]>([]);
let live = $state(false);

$effect(() => {
  runs = $state.snapshot(data.runs) as RunView[];
});

$effect(() => {
  const source = new EventSource(`/projects/${encodeURIComponent(data.projectId)}/events`);
  source.addEventListener("open", () => (live = true));
  source.addEventListener("error", () => (live = false));
  source.addEventListener("runs-snapshot", (e) => {
    runs = JSON.parse((e as MessageEvent).data) as RunView[];
  });
  source.addEventListener("runs-delta", (e) => {
    const run = JSON.parse((e as MessageEvent).data) as RunView;
    const rest = runs.filter((r) => r.id !== run.id);
    runs = [run, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
  return () => source.close();
});
</script>

<svelte:head>
  <title>{data.projectId} · stardust</title>
</svelte:head>

<main>
  <h1>{data.projectId}</h1>
  <p data-live={live}>{live ? "Live" : "Connecting…"}</p>
  <form method="POST" action="?/pull" data-pull>
    <select name="kind" aria-label="What to pull">
      <option value="branch">Branch</option>
      <option value="tag">Tag</option>
      <option value="sha">Commit</option>
    </select>
    <input name="ref" placeholder="default branch" aria-label="Branch, tag or commit" />
    <button type="submit">Pull and deliver</button>
  </form>
  {#if form?.pullError}
    <p role="alert" data-pull-error>{form.pullError}</p>
  {:else if form?.pulled}
    <p data-pulled>Started a run for {form.pulled.ref} at <code>{form.pulled.sha.slice(0, 7)}</code>.</p>
  {/if}
  {#if runs.length === 0}
    <p>No runs yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Run</th><th>Ref</th><th>Commit</th><th>Status</th><th>Jobs</th></tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          <tr data-run={run.id} data-status={run.status}>
            <td>{new Date(run.createdAt).toLocaleString()}</td>
            <td>{run.ref}{#if run.requestedBy}<br /><small>pulled by {run.requestedBy}</small>{/if}</td>
            <td><code>{run.sha.slice(0, 7)}</code></td>
            <td>{run.status}</td>
            <td>
              {#each run.jobs as job (job.name)}
                <span data-job={job.name} data-status={job.status}>{job.name}: {job.status}</span>
              {/each}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  <form method="POST" action="/logout"><button type="submit">Sign out</button></form>
</main>
