<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Cloud audit · stardust</title>
</svelte:head>

<main>
  <h1>Cloud audit</h1>
  <form method="POST" action="?/scan"><button type="submit">Scan now</button></form>
  {#if form?.error}<p role="alert">{form.error}</p>{/if}

  <h2>Sources</h2>
  <ul data-sources>
    {#each data.sources as s (s.source)}
      <li data-source={s.source} data-failing={Boolean(s.lastError)}>
        <strong>{s.source}</strong>: read up to {s.scannedUntil ? new Date(s.scannedUntil).toLocaleString() : "nothing yet"}
        {#if s.lastScanAt}(last scan {new Date(s.lastScanAt).toLocaleString()}, {s.lastCount ?? 0} records){/if}
        {#if s.lastError}<br /><strong>{s.lastError}</strong>{/if}
      </li>
    {:else}
      <li>Not scanned yet.</li>
    {/each}
  </ul>

  <h2>Findings</h2>
  <table data-findings>
    <thead><tr><th>When</th><th>Severity</th><th>Rule</th><th>What</th><th>Who</th></tr></thead>
    <tbody>
      {#each data.findings as f (`${f.source}/${f.recordId}/${f.rule}`)}
        <tr data-severity={f.severity}>
          <td>{f.occurredAt ? new Date(f.occurredAt).toLocaleString() : "?"}</td>
          <td>{f.severity}</td>
          <td><code>{f.rule}</code></td>
          <td>{f.reason}</td>
          <td>{f.actorType}{f.actorEmail ? ` ${f.actorEmail}` : ""}{f.actorIp ? ` from ${f.actorIp}` : ""}</td>
        </tr>
      {:else}
        <tr><td colspan="5">Nothing found.</td></tr>
      {/each}
    </tbody>
  </table>
</main>
