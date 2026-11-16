<script lang="ts">
let { data, form } = $props();
const projectHref = $derived(`/projects/${encodeURIComponent(data.projectId)}`);
const time = (iso: string) => new Date(iso).toLocaleString();
const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
</script>

<svelte:head>
  <title>{data.component} · {data.projectId} · stardust</title>
</svelte:head>

<main>
  <p><a href={projectHref}>← {data.projectId}</a></p>
  <h1>{data.component}</h1>

  {#if form?.rollbackError}
    <p role="alert" data-rollback-error>{form.rollbackError}</p>
  {:else if form?.rolledBack}
    <p data-rolled-back>
      {form.rolledBack.status === "committed" ? "Rolled back" : "Already there"}: now
      <code>{form.rolledBack.sha.slice(0, 7)}</code>{form.rolledBack.deployCommit
        ? `, deploy commit ${form.rolledBack.deployCommit.slice(0, 7)}`
        : ""}.
    </p>
  {/if}

  <h2>Deliveries</h2>
  {#if data.deliveries.length === 0}
    <p>Nothing has been delivered yet.</p>
  {:else}
    <form method="POST" action="?/rollback" data-rollback-previous>
      <button type="submit" disabled={data.deliveries.length < 2}>Roll back to the previous delivery</button>
    </form>
    <table>
      <thead>
        <tr><th>Finished</th><th>Commit</th><th>Image</th><th>Deploy commit</th><th></th></tr>
      </thead>
      <tbody>
        {#each data.deliveries as d, i (d.jobId)}
          <tr data-delivery={d.jobId}>
            <td>{time(d.finishedAt)}</td>
            <td><a href={`${projectHref}/runs/${encodeURIComponent(d.runId)}`}><code>{d.sha.slice(0, 7)}</code></a></td>
            <td><code title={d.digest}>{short(d.digest)}</code></td>
            <td>{#if d.deployCommit}<code>{d.deployCommit.slice(0, 7)}</code>{:else}—{/if}</td>
            <td>
              {#if i > 0}
                <form method="POST" action="?/rollback">
                  <input type="hidden" name="job" value={d.jobId} />
                  <button type="submit">Roll back to this</button>
                </form>
              {:else}
                latest
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  table {
    border-collapse: collapse;
  }
  td,
  th {
    padding: 0.25rem 0.75rem;
    text-align: left;
  }
</style>
