<script lang="ts">
let { data, form } = $props();

const title = (layer: string) => (layer === "_shared" ? "Every component" : layer);
const confirmRemove = (e: SubmitEvent, name: string) => {
  if (!confirm(`Remove ${name}? The workloads that use it roll out without it.`)) e.preventDefault();
};
</script>

<svelte:head>
  <title>Env · {data.projectId} · stardust</title>
</svelte:head>

<main>
  <p><a href={`/projects/${encodeURIComponent(data.projectId)}`}>{data.projectId}</a></p>
  <h1>Environment</h1>
  {#if data.off}
    <p data-env-off>{data.off}. An administrator enables it by giving the server the deploy repository and SOPS.</p>
  {:else if data.env}
    <p>
      Each change is one commit to the deploy repository; the workloads that use the env roll out when it is applied.
      Secret values are never shown again once saved.
    </p>
    {#if form?.error}
      <p role="alert" data-env-error>{form.layer ? `${title(form.layer)}: ` : ""}{form.name ? `${form.name}: ` : ""}{form.error}</p>
    {:else if form?.result}
      <p data-env-result>
        {#if form.result.status === "no_change"}
          Nothing changed: {form.name} already had that value.
        {:else}
          Committed <code>{form.result.commit?.slice(0, 12)}</code>.
          {#each form.result.components as c (c.name)}
            {#if c.consumers.length > 0}
              {c.name} rolls out {c.consumers.join(", ")}.
            {:else}
              <strong data-env-unused>Nothing in {c.name} uses this env yet</strong>: add <code>envFrom</code> for
              <code>{c.name}-env</code> and <code>{c.name}-env-secret</code> to its workload.
            {/if}
          {/each}
        {/if}
      </p>
    {/if}

    {#each data.env.layers as layer (layer.layer)}
      <section data-env-layer={layer.layer}>
        <h2>{title(layer.layer)}</h2>
        {#if Object.keys(layer.plain).length === 0 && layer.secrets.length === 0}
          <p>No values.</p>
        {:else}
          <table>
            <thead><tr><th>Name</th><th>Value</th>{#if data.env.canEdit}<th></th>{/if}</tr></thead>
            <tbody>
              {#each Object.entries(layer.plain) as [name, value] (name)}
                <tr data-env-plain={name}>
                  <td><code>{name}</code></td>
                  <td><code>{value}</code></td>
                  {#if data.env.canEdit}
                    <td>
                      <form method="POST" action="?/unset" onsubmit={(e) => confirmRemove(e, name)}>
                        <input type="hidden" name="layer" value={layer.layer} />
                        <input type="hidden" name="revision" value={layer.revision} />
                        <input type="hidden" name="name" value={name} />
                        <button type="submit">Remove</button>
                      </form>
                    </td>
                  {/if}
                </tr>
              {/each}
              {#each layer.secrets as name (name)}
                <tr data-env-secret={name}>
                  <td><code>{name}</code></td>
                  <td><em>secret, set</em></td>
                  {#if data.env.canEdit}
                    <td>
                      <form method="POST" action="?/set">
                        <input type="hidden" name="layer" value={layer.layer} />
                        <input type="hidden" name="revision" value={layer.revision} />
                        <input type="hidden" name="name" value={name} />
                        <input type="hidden" name="kind" value="secret" />
                        <input
                          type="password"
                          name="value"
                          autocomplete="new-password"
                          aria-label={`New value for ${name}`}
                          placeholder="new value"
                          required
                        />
                        <button type="submit">Replace</button>
                      </form>
                      <form method="POST" action="?/unset" onsubmit={(e) => confirmRemove(e, name)}>
                        <input type="hidden" name="layer" value={layer.layer} />
                        <input type="hidden" name="revision" value={layer.revision} />
                        <input type="hidden" name="name" value={name} />
                        <input type="hidden" name="kind" value="secret" />
                        <button type="submit">Remove</button>
                      </form>
                    </td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
        {#if data.env.canEdit}
          <form method="POST" action="?/set" data-env-add>
            <input type="hidden" name="layer" value={layer.layer} />
            <input type="hidden" name="revision" value={layer.revision} />
            <label>Name <input name="name" required pattern="[A-Za-z_][A-Za-z0-9_]*" autocomplete="off" /></label>
            <label>
              Kind
              <select name="kind">
                <option value="plain">Plain value</option>
                <option value="secret">Secret</option>
              </select>
            </label>
            <!-- A password field for both kinds: nothing typed here is echoed or prefilled. -->
            <label>Value <input type="password" name="value" autocomplete="new-password" /></label>
            <button type="submit">Save</button>
          </form>
        {/if}
      </section>
    {/each}
  {/if}
</main>
