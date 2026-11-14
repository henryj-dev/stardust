<script lang="ts">
let { data, form } = $props();
const projectHref = $derived(`/projects/${encodeURIComponent(data.projectId)}`);
const time = (iso: string) => new Date(iso).toLocaleString();
const short = (digest: string) => digest.replace(/^sha256:/, "").slice(0, 12);
const LANDING: Record<string, string> = {
  live: "running with it",
  "committed-not-applied": "committed; the GitOps controller has not applied it yet",
  "applied-not-rolled-out": "applied; the workload is still rolling out",
  "no-consumer": "applied, but this workload does not use it",
};
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

  {#if data.env?.revision}
    <h2>Environment</h2>
    <p data-env-revision>Revision <code>{data.env.revision}</code></p>
    <ul>
      {#each data.env.landing as l (l.workload)}
        <li data-env-landing={l.state}>{l.workload}: {LANDING[l.state] ?? l.state}</li>
      {/each}
    </ul>
  {/if}

  <h2>Running now</h2>
  {#if form?.runtimeActionError}
    <p role="alert" data-runtime-error>{form.runtimeActionError}</p>
  {:else if form?.restarted}
    <p data-restarted>
      {form.restarted.status === "committed"
        ? `Restart committed (${form.restarted.deployCommit?.slice(0, 7)}); the controller rolls it out.`
        : "Nothing to restart."}
    </p>
  {:else if form?.scaled}
    <p data-scaled>{form.scaled.name}: {form.scaled.status === "committed" ? `scaled to ${form.scaled.replicas}` : "already at that scale"}.</p>
  {/if}
  {#if data.runtimeError}
    <p role="alert">The cluster could not be read: {data.runtimeError}</p>
  {:else if !data.runtime}
    <p>Enable the runtime plugin to see what this component runs.</p>
  {:else}
    {#if data.can.restart}
      <form method="POST" action="?/restart" data-restart>
        <button type="submit">Restart</button>
      </form>
    {/if}
    {#each data.runtime.workloads as w (`${w.kind}/${w.name}`)}
      <section data-workload={`${w.kind}/${w.name}`}>
        <h3>{w.kind} {w.name}</h3>
        {#if "error" in w}
          <p role="alert">{w.error}</p>
        {:else}
          <p>
            {w.namespace} · ready {w.ready}/{w.desired ?? "—"} · updated {w.updated} · available {w.available}
          </p>
          {#if data.can.scale && w.kind !== "DaemonSet"}
            <form method="POST" action="?/scale" data-scale>
              <input type="hidden" name="kind" value={w.kind} />
              <input type="hidden" name="workload" value={w.name} />
              <input name="replicas" type="number" min="0" max="100" value={w.desired ?? 1} aria-label="Replicas" />
              <button type="submit">Scale</button>
            </form>
          {/if}
          <table>
            <thead><tr><th>Pod</th><th>Phase</th><th>Ready</th><th>Restarts</th><th>Node</th><th>Containers</th></tr></thead>
            <tbody>
              {#each w.pods as p (p.name)}
                <tr data-pod={p.name}>
                  <td>
                    <code>{p.name}</code>
                    {#if data.can.logs}
                      · <a href={`/projects/${encodeURIComponent(data.projectId)}/components/${encodeURIComponent(data.component)}/pods/${encodeURIComponent(p.name)}`}>log</a>
                    {/if}
                  </td>
                  <td>{p.phase}</td>
                  <td>{p.ready ? "yes" : "no"}</td>
                  <td>{p.restarts}</td>
                  <td>{p.node ?? "—"}</td>
                  <td>
                    {#each p.containers as c (c.name)}
                      <div>{c.name}: {c.state}{c.reason ? ` (${c.reason})` : ""}</div>
                    {/each}
                  </td>
                </tr>
              {:else}
                <tr><td colspan="6">No pods.</td></tr>
              {/each}
            </tbody>
          </table>
          {#if w.events.length > 0}
            <details>
              <summary>Events ({w.events.length})</summary>
              <ul>
                {#each w.events as e, i (i)}
                  <li data-event-type={e.type}>{e.at ? new Date(e.at).toLocaleString() : "—"} · {e.object} · <strong>{e.reason}</strong> {e.message}{e.count > 1 ? ` ×${e.count}` : ""}</li>
                {/each}
              </ul>
            </details>
          {/if}
        {/if}
      </section>
    {/each}
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
