<script lang="ts">
let { data, form } = $props();
const shown = (name: string) =>
  form && "connection" in form && form.connection?.name === name ? form.connection : null;
</script>

<svelte:head>
  <title>Databases · stardust</title>
</svelte:head>

<main>
  <h1>Databases</h1>
  <p>
    Every change here is a commit to the deploy repository. Passwords are generated on the server and sealed; a
    superuser's is shown only when an administrator asks, and every asking is recorded in the audit log.
    {#if data.backup}Backups run at <code>{data.backup.schedule}</code> (UTC).{:else}<strong>Backups are not configured.</strong>{/if}
  </p>
  {#if form?.error}<p role="alert">{form.error}</p>{:else if form && "ok" in form && form.ok}<p data-done>Committed.</p>{/if}

  <table data-instances>
    <thead><tr><th>Instance</th><th>Where</th><th>Version</th><th>State</th><th>Restores</th><th>Grants</th><th>Connect</th></tr></thead>
    <tbody>
      {#each data.instances as i (i.name)}
        <tr data-instance={i.name}>
          <td>{i.name}<br /><small>{i.origin} · {i.provider}</small></td>
          <td>
            <code>{i.host}</code>
            {#if i.external}
              <br /><small data-external>outside: <code>{i.external.address}</code></small>
            {:else if data.externalAddresses}
              <form method="POST" action="?/external">
                <input type="hidden" name="instance" value={i.name} />
                <button type="submit" data-add-external>Add an address outside</button>
              </form>
            {/if}
          </td>
          <td>{i.version ?? "—"}</td>
          <td>{!i.present ? "not running yet" : i.ready ? "ready" : "not ready"}</td>
          <td data-check={i.lastCheck?.status ?? "never"}>
            {#if i.lastCheck}
              <span title={i.lastCheck.detail ?? ""}>{i.lastCheck.status}</span>
              <small>{new Date(i.lastCheck.finishedAt ?? i.lastCheck.requestedAt).toLocaleString()}</small>
            {:else}
              never checked
            {/if}
            {#if data.restoreChecks && i.lastCheck?.status !== "pending"}
              <form method="POST" action="?/check">
                <input type="hidden" name="instance" value={i.name} />
                <button type="submit">Check that it restores</button>
              </form>
            {/if}
          </td>
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
          <td>
            {#if shown(i.name)}
              {@const c = shown(i.name)}
              <dl data-connection>
                <dt>Superuser</dt><dd><code>{c?.role}</code></dd>
                <dt>Inside the cluster</dt>
                <dd><textarea readonly rows="2" aria-label={`URL of ${i.name} inside the cluster`}>{c?.inCluster.url}</textarea></dd>
                {#if c?.external}
                  <dt>Outside</dt>
                  <dd><textarea readonly rows="2" aria-label={`URL of ${i.name} outside`}>{c.external.url}</textarea></dd>
                {/if}
              </dl>
              <a href="?" data-connection-hide>Hide</a>
            {:else if i.connection}
              <form method="POST" action="?/connection">
                <input type="hidden" name="instance" value={i.name} />
                <button type="submit" data-connection-show>Show DATABASE_URL</button>
              </form>
            {:else}
              <small>its password is in the cluster only</small>
            {/if}
          </td>
        </tr>
      {:else}
        <tr><td colspan="7">No instances yet.</td></tr>
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

  {#if data.allowDelete && data.instances.length}
    <h2>Delete an instance</h2>
    <p>
      Revoke its grants first. One stardust created also needs a passed restore check in the last day; its manifests go
      but its volume claim and data stay until you delete them. An adopted instance is only forgotten.
    </p>
    <form method="POST" action="?/remove" data-delete>
      <label>Instance <select name="instance">{#each data.instances as i (i.name)}<option>{i.name}</option>{/each}</select></label>
      <label>Type its name again <input name="confirm" required autocomplete="off" /></label>
      <button type="submit">Delete</button>
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
      {#if data.externalAddresses}
        <input type="hidden" name="offersExternal" value="1" />
        <label><input type="checkbox" name="external" checked /> With an address outside the cluster</label>
      {/if}
      <button type="submit">Create</button>
    </form>
  {/if}
</main>
