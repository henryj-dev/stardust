<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Domains · stardust</title>
</svelte:head>

<main>
  <h1>Domains</h1>
  <form method="POST" action="?/sync"><button type="submit">Refresh from the providers</button></form>
  {#if form?.error}<p role="alert">{form.error}</p>{:else if form?.synced}<p data-synced>{form.synced.zones} zone(s).</p>{/if}
  <table data-domains>
    <thead><tr><th>Domain</th><th>DNS</th><th>Registrar</th><th>Expires</th></tr></thead>
    <tbody>
      {#each data.domains as d (`${d.name}/${d.provider}`)}
        <tr data-domain={d.name} data-soon={d.daysLeft !== null && d.daysLeft < 30}>
          <td><a href={`/domains/${encodeURIComponent(d.name)}`}>{d.name}</a></td>
          <td>{d.provider}</td>
          <td>{d.registrar ?? "—"}</td>
          <td>
            {#if d.expiresAt}
              {new Date(d.expiresAt).toLocaleDateString()} ({d.daysLeft} days){#if d.daysLeft !== null && d.daysLeft < 30} <strong>soon</strong>{/if}
            {:else if d.rdapError}
              <span title={d.rdapError}>unknown</span>
            {:else}
              —
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="4">No zones yet: refresh from the providers.</td></tr>
      {/each}
    </tbody>
  </table>
</main>
