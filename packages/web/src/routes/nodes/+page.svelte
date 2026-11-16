<script lang="ts">
let { data, form } = $props();
const usedPct = (m: { memTotalMb: number | null; memAvailMb: number | null }) =>
  m.memTotalMb && m.memAvailMb !== null ? Math.round(((m.memTotalMb - m.memAvailMb) / m.memTotalMb) * 100) : null;
const fullest = (disk: Record<string, number>) => {
  const e = Object.entries(disk).sort((a, b) => b[1] - a[1])[0];
  return e ? `${e[0]} ${e[1]}%` : "—";
};
</script>

<svelte:head>
  <title>Nodes · stardust</title>
</svelte:head>

<main>
  <h1>Nodes</h1>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}
  {#if form?.issued}
    <section data-issued>
      <p>A token for <strong>{form.issued.hostname}</strong>. It is shown only now: put it in the agent's <code>/etc/node-agent/token</code>.</p>
      <pre><code>{form.issued.token}</code></pre>
    </section>
  {/if}

  <table data-nodes>
    <thead><tr><th>Host</th><th>State</th><th>Agent</th><th>Load</th><th>Memory</th><th>Fullest disk</th><th>Last beat</th></tr></thead>
    <tbody>
      {#each data.nodes as n (n.hostname)}
        <tr data-node={n.hostname} data-state={n.state}>
          <td>{n.hostname}{n.hasToken ? "" : " (no token)"}</td>
          <td>{n.state}</td>
          <td>{n.agentVersion ?? "—"}</td>
          <td>{n.metrics?.load ? n.metrics.load.map((l) => l.toFixed(2)).join(" ") : "—"}</td>
          <td>{n.metrics ? `${usedPct(n.metrics) ?? "—"}%` : "—"}</td>
          <td>{n.metrics ? fullest(n.metrics.disk) : "—"}</td>
          <td>{n.lastBeatAt ? new Date(n.lastBeatAt).toLocaleString() : "never"}</td>
        </tr>
      {:else}
        <tr><td colspan="7">No hosts yet: issue a token below.</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>Agent tokens</h2>
  <p>Issuing a token for a host revokes its earlier one. A revoked host's agent is disconnected at its next beat.</p>
  <table data-tokens>
    <thead><tr><th>Host</th><th>Label</th><th>Issued</th><th>Last used</th><th></th></tr></thead>
    <tbody>
      {#each data.tokens as t (t.id)}
        <tr>
          <td>{t.hostname}</td>
          <td>{t.label ?? ""}</td>
          <td>{new Date(t.createdAt).toLocaleDateString()}{t.createdBy ? ` by ${t.createdBy}` : ""}</td>
          <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "never"}</td>
          <td>
            <form method="POST" action="?/revoke">
              <input type="hidden" name="id" value={t.id} />
              <button type="submit">Revoke</button>
            </form>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
  <form method="POST" action="?/issue" data-issue>
    <label>Host name <input name="hostname" required /></label>
    <label>Label <input name="label" maxlength="120" /></label>
    <button type="submit">Issue a token</button>
  </form>
</main>
