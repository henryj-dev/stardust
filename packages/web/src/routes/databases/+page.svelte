<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Databases · stardust</title>
</svelte:head>

<main>
  <h1>Databases</h1>
  <p>
    Every change here is a commit to the deploy repository. Passwords are generated on the server and sealed; they are
    never shown.
    {#if data.backup}Backups run at <code>{data.backup.schedule}</code> (UTC).{:else}<strong>Backups are not configured.</strong>{/if}
  </p>
  {#if form?.error}<p role="alert">{form.error}</p>{:else if form?.ok}<p data-done>Committed.</p>{/if}

  <table data-instances>
    <thead><tr><th>Instance</th><th>Where</th><th>Version</th><th>State</th><th>Grants</th></tr></thead>
    <tbody>
      {#each data.instances as i (i.name)}
        <tr data-instance={i.name}>
          <td>{i.name}<br /><small>{i.origin} · {i.provider}</small></td>
          <td><code>{i.host}</code></td>
          <td>{i.version ?? "—"}</td>
          <td>{!i.present ? "not running yet" : i.ready ? "ready" : "not ready"}</td>
          <td>
            {#each i.grants as g (g.role)}
              <form method="POST" action="?/revoke">
                <code>{g.role}</code> → {g.database} for {g.project}/{g.layer}
                <input type="hidden" name="instance" value={i.name} />
                <input type="hidden" name="role" value={g.role} />
                <button type="submit">Revoke</button>
              </form>
            {:else}
              none
            {/each}
          </td>
        </tr>
      {:else}
        <tr><td colspan="5">No instances yet.</td></tr>
      {/each}
    </tbody>
  </table>

  {#if data.unmanaged.length}
    <h2>Running, not managed</h2>
    <p>Adopting records an instance and backs it up; it does not change it.</p>
    <table data-unmanaged>
      <thead><tr><th>Workload</th><th>Version</th><th></th></tr></thead>
      <tbody>
        {#each data.unmanaged as u (`${u.provider}/${u.namespace}/${u.workload}`)}
          <tr>
            <td>{u.namespace}/{u.workload}</td>
            <td>{u.version ?? "—"}</td>
            <td>
              {#if u.adoptable}
                <form method="POST" action="?/adopt">
                  <input type="hidden" name="provider" value={u.provider} />
                  <input type="hidden" name="namespace" value={u.namespace} />
                  <input type="hidden" name="workload" value={u.workload} />
                  <label>As <input name="name" value={u.workload} /></label>
                  <button type="submit">Adopt</button>
                </form>
              {:else}
                its password is not read from a Secret
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  {#if data.instances.length && data.envEditing}
    <h2>Give an application a database</h2>
    <p>Creates a role and a database it owns, and sets DATABASE_URL and PG* in the layer's env, so it rolls out.</p>
    <form method="POST" action="?/grant" data-grant>
      <label>Instance <select name="instance">{#each data.instances as i (i.name)}<option>{i.name}</option>{/each}</select></label>
      <label>Project <input name="project" required /></label>
      <label>Layer <input name="layer" placeholder="_shared or a component" /></label>
      <label>Role <input name="role" required pattern="[a-z_][a-z0-9_]*" /></label>
      <label>Database <input name="database" placeholder="the role's name" /></label>
      <label>Env prefix <input name="envPrefix" placeholder="e.g. ORDERS_" /></label>
      <button type="submit">Grant</button>
    </form>
  {/if}

  {#if data.engines.length}
    <h2>Create an instance</h2>
    <form method="POST" action="?/create" data-create>
      <label>Name <input name="name" required pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?" /></label>
      <label>Engine <select name="provider">{#each data.engines as e (e.name)}<option value={e.name}>{e.name} ({e.namespace})</option>{/each}</select></label>
      <label>Version <select name="version">{#each data.engines[0]?.versions ?? [] as v (v)}<option selected={v === data.engines[0]?.versions.at(-1)}>{v}</option>{/each}</select></label>
      <label>Storage <input name="storage" value="10Gi" /></label>
      <label>CPU <input name="cpu" value="250m" /></label>
      <label>Memory <input name="memory" value="512Mi" /></label>
      <button type="submit">Create</button>
    </form>
  {/if}
</main>
