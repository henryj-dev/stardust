<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Instances · stardust</title>
</svelte:head>

<main>
  <h1>Instances <small>({data.account})</small></h1>
  {#if form?.error}<p role="alert">{form.error}</p>{:else if form?.ok}<p data-done>Done.</p>{/if}

  <table data-instances>
    <thead><tr><th>Host</th><th>State</th><th>Where</th><th>Plan</th><th>Addresses</th><th></th></tr></thead>
    <tbody>
      {#each data.instances as i (i.id)}
        <tr data-instance={i.hostname} data-state={i.state}>
          <td>{i.hostname}{#if i.protected} <strong>protected</strong>{/if}<br /><small>{i.os ?? "unknown OS"}</small></td>
          <td>{i.state}</td>
          <td>{i.region}</td>
          <td>
            {#if data.capabilities.resize}
              <form method="POST" action="?/resize">
                <input type="hidden" name="id" value={i.id} />
                <select name="plan">{#each data.catalog.plans.filter((p) => p.regions.includes(i.region)) as p (p.id)}<option value={p.id} selected={p.id === i.plan}>{p.id} (${p.monthlyCost}/mo)</option>{/each}</select>
                <button type="submit">Resize</button>
              </form>
            {:else}{i.plan}{/if}
          </td>
          <td>{i.mainIp ?? "—"}{#if i.internalIp}<br /><small>{i.internalIp}</small>{/if}</td>
          <td>
            {#if !i.protected}
              {#if form?.approved?.id === i.id}
                <form method="POST" action="?/remove">
                  <input type="hidden" name="id" value={i.id} />
                  <input type="hidden" name="ticket" value={form.approved.ticket} />
                  <button type="submit">Delete {i.hostname} now</button>
                </form>
              {:else}
                <form method="POST" action="?/approve">
                  <input type="hidden" name="id" value={i.id} />
                  <input name="confirm" placeholder="type its hostname" autocomplete="off" />
                  <button type="submit">Delete…</button>
                </form>
              {/if}
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="6">No instances.</td></tr>
      {/each}
    </tbody>
  </table>

  <h2>Create an instance</h2>
  <p>It is made in the background: the cloud machine, its DNS records and reverse name, then its user data is cleared.</p>
  <form method="POST" action="?/create" data-create>
    <label>Hostname <input name="hostname" required /></label>
    <label>Region <select name="region">{#each data.catalog.regions as r (r.id)}<option value={r.id}>{r.city} ({r.id})</option>{/each}</select></label>
    <label>Plan <select name="plan">{#each data.catalog.plans as p (p.id)}<option value={p.id}>{p.id}: {p.vcpus} vCPU, {p.memoryMb} MB, ${p.monthlyCost}/mo</option>{/each}</select></label>
    <label>Image <select name="image">{#each data.catalog.images as o (o.id)}<option value={o.id}>{o.name}</option>{/each}</select></label>
    {#each data.catalog.networks as n (n.id)}<label><input type="checkbox" name="networks" value={n.id} /> {n.name} ({n.region})</label>{/each}
    <button type="submit">Create</button>
  </form>

  <h2>Recent operations</h2>
  <ul data-ops>
    {#each data.ops as o (o.id)}
      <li>{o.kind} {o.hostname}: {o.status}{o.error ? ` — ${o.error}` : ""} <small>by {o.requestedBy}</small></li>
    {/each}
  </ul>
</main>
