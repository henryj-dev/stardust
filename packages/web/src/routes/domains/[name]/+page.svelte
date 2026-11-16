<script lang="ts">
let { data, form } = $props();
const TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA", "NS"];
</script>

<svelte:head>
  <title>{data.domain.name} · stardust</title>
</svelte:head>

<main>
  <p><a href="/domains">← Domains</a></p>
  <h1>{data.domain.name}</h1>
  <p>DNS at {data.domain.provider} · registrar {data.domain.registrar ?? "unknown"} · expires {data.domain.expiresAt ? new Date(data.domain.expiresAt).toLocaleDateString() : "unknown"}</p>
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {:else if form?.saved}
    <p data-saved>{form.saved.served ? "Saved and served." : "Saved; the provider is still publishing it."}</p>
  {/if}

  <h2>Records</h2>
  <table data-records>
    <thead><tr><th>Name</th>{#if data.capabilities.views.length}<th>View</th>{/if}<th>Type</th><th>Content</th><th>TTL</th><th></th></tr></thead>
    <tbody>
      {#each data.records as r (`${r.view}/${r.id}`)}
        <tr>
          <td>{r.name}</td>
          {#if data.capabilities.views.length}<td>{r.view}</td>{/if}
          <td>{r.type}</td>
          <td><code>{r.content}</code>{r.proxied ? " (proxied)" : ""}</td>
          <td>{r.ttl}</td>
          <td>
            <form method="POST" action="?/remove">
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="view" value={r.view ?? ""} />
              <button type="submit">Remove</button>
            </form>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h2>Set a record</h2>
  <p>A record with the same name and type{data.capabilities.views.length ? " in the same view" : ""} is replaced.</p>
  <form method="POST" action="?/set" data-set-record>
    <label>Name <input name="name" required value={`.${data.domain.name}`} /></label>
    {#if data.capabilities.views.length}
      <label>View <select name="view">{#each data.capabilities.views as v (v)}<option>{v}</option>{/each}</select></label>
    {/if}
    <label>Type <select name="type">{#each TYPES as t (t)}<option>{t}</option>{/each}</select></label>
    <label>Content <input name="content" required /></label>
    <label>TTL <input name="ttl" type="number" min="1" max="86400" value="300" /></label>
    {#if data.capabilities.proxied}<label><input type="checkbox" name="proxied" /> Proxied</label>{/if}
    <button type="submit">Save</button>
  </form>
</main>
