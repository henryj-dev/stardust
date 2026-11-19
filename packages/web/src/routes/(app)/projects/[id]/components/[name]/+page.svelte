<script lang="ts">
import { reachOf } from "$lib/exposure";

let { data, form } = $props();
const reach = $derived(reachOf(data.runtime?.services ?? []));
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
  <p class="crumb"><a href={projectHref}>{data.projectId}</a> /</p>
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

  {#if reach.length > 0}
    <h2>Reaching it</h2>
    <p>
      Where an edge proxy sends this component's traffic. stardust gives a Service an address; routing a public
      host to it (which paths, body limits, logging) and its DNS record are set at the edge.
    </p>
    <ul>
      {#each reach as r (r.service)}
        <li data-reach={r.state}>
          Service <code>{r.service}</code>:
          {#if r.state === "ready"}
            send to {#each r.upstreams as u, i (u)}{i > 0 ? ", " : ""}<code>{u}</code>{/each}
          {:else}
            {r.note}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if data.access}
    <h2>Cluster access</h2>
    <ul>
      <li data-access-pull={data.access.registryPull.on ? "on" : "off"}>
        Registry pull Secret: {data.access.registryPull.on ? "managed by stardust" : "none"}
        {#if data.access.registryPull.others.length > 0}
          · also named by hand: {#each data.access.registryPull.others as o, i (o)}{i > 0 ? ", " : ""}<code>{o}</code>{/each}
          (remove it from the manifests once stardust's works)
        {/if}
        {#if !data.access.registryPull.available}
          · stardust has no pull login configured (<code>plugins.builder-buildkit.pull</code>)
        {/if}
      </li>
      <li data-access-podview={data.access.podView.on ? "on" : "off"}>
        Pod view: {data.access.podView.on ? "stardust may read this namespace" : "not granted by stardust"}
        {#if !data.access.podView.available}
          · the chart's <code>runtime.bindings</code> is off
        {/if}
      </li>
      <li data-access-env={data.access.envVars.on ? "on" : "off"}>
        Env variables: {data.access.envVars.on
          ? "the containers read the env page's values"
          : "the containers do not read the env page's values; values set there do not reach the process"}
      </li>
    </ul>
    {#if data.isAdmin && data.access.namespace}
      <form method="POST" action="?/access" data-access>
        {#if data.access.registryPull.available}
          <input type="hidden" name="registryPull.shown" value="1" />
          <label
            ><input type="checkbox" name="registryPull" checked={data.access.registryPull.on} /> Pull images with stardust's
            registry login (a sealed Secret in <code>{data.access.namespace}</code>)</label
          >
        {/if}
        {#if data.access.podView.available}
          <input type="hidden" name="podView.shown" value="1" />
          <label
            ><input type="checkbox" name="podView" checked={data.access.podView.on} /> Let stardust read
            <code>{data.access.namespace}</code> for this page (read-only)</label
          >
        {/if}
        <input type="hidden" name="envVars.shown" value="1" />
        <label
          ><input type="checkbox" name="envVars" checked={data.access.envVars.on} /> Read the env page's values as
          environment variables (<code>envFrom</code> in each container)</label
        >
        <button type="submit">Save access</button>
      </form>
    {/if}
    {#if data.isAdmin && data.access.registryPull.available}
      <form method="POST" action="?/reseal" data-reseal>
        <button type="submit">Reseal every component's pull Secret</button> after the registry login changed
      </form>
    {/if}
    {#if form?.accessError}
      <p role="alert" data-access-error>{form.accessError}</p>
    {:else if form?.accessSaved}
      <p data-access-saved>
        {form.accessSaved.status === "committed"
          ? `Committed ${form.accessSaved.deployCommit?.slice(0, 7) ?? ""}; it takes effect when it is applied.`
          : "Nothing to change."}
      </p>
    {:else if form?.resealed}
      <p data-resealed>
        {form.resealed.status === "committed"
          ? `Resealed ${form.resealed.components.join(", ")} (${form.resealed.deployCommit?.slice(0, 7) ?? ""}).`
          : "Every pull Secret already holds the current login."}
      </p>
    {/if}
  {/if}

  {#if data.isAdmin && data.deliveries.length === 0}
    <details data-scaffold>
      <summary>No manifests yet? Create starter manifests</summary>
      <p>
        A Deployment using this component's image (and a Service for its port) in its deploy directory, which must
        be empty. A delivery then points it at each build.
      </p>
      <form method="POST" action="?/scaffold">
        <label>Namespace <input name="namespace" required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" /></label>
        <label>Port <input name="port" type="number" min="1" max="65535" /></label>
        <!-- Off for a namespace other things share: withdrawing the component would remove it. -->
        <label
          ><input type="checkbox" name="createNamespace" /> Also create the namespace (restricted Pod Security; removed
          with the component)</label
        >
        <label
          ><input type="checkbox" name="expose" /> Give the Service an address outside the cluster (a LoadBalancer),
          for an edge proxy</label
        >
        {#if data.access?.registryPull.available}
          <label><input type="checkbox" name="registryPull" checked /> Pull with stardust's registry login</label>
        {/if}
        {#if data.access?.podView.available}
          <label><input type="checkbox" name="podView" checked /> Let stardust read the namespace for this page</label>
        {/if}
        <button type="submit">Create manifests</button>
      </form>
    </details>
    {#if form?.scaffoldError}
      <p role="alert">{form.scaffoldError}</p>
    {:else if form?.scaffolded}
      <p data-scaffolded>
        Created {form.scaffolded.files.join(", ")}.
        {#if form.scaffolded.listedIn}
          Listed in <code>{form.scaffolded.listedIn}</code>, so it is applied.
        {:else}
          No kustomization above the directory lists it: add it where your GitOps controller applies from.
        {/if}
      </p>
    {/if}
  {/if}

  {#if data.files}
    <h2>Files</h2>
    <p>
      Env secrets this component reads as files, for programs that read a key or a config file from disk. Each one
      is mounted read-only at its own path. Saving commits the Deployment; it rolls out when it is applied.
    </p>
    {#if data.files.secrets.length === 0}
      <p data-files-none>
        No env secret reaches this component yet. Add one on the <a href={`${projectHref}/env`}>env page</a> (a file
        can be its value), then mount it here.
      </p>
    {:else}
      <form method="POST" action="?/files" data-files>
        <table>
          <thead><tr><th>Secret</th><th>Path in the container</th></tr></thead>
          <tbody>
            {#each [...data.files.mounts, { key: "", path: "" }] as m, i (i)}
              <tr data-file-row={i}>
                <td>
                  <select name={`mounts.${i}.key`} aria-label={`Secret for file ${i + 1}`}>
                    {#each data.files.secrets as s (s)}
                      <option value={s} selected={s === m.key}>{s}</option>
                    {/each}
                  </select>
                </td>
                <td>
                  <input
                    name={`mounts.${i}.path`}
                    value={m.path}
                    placeholder={i === data.files.mounts.length ? "/etc/app/key.pem (add a file)" : "clear to remove"}
                    aria-label={`Path for file ${i + 1}`}
                    autocomplete="off"
                  />
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        <button type="submit">Save files</button>
      </form>
    {/if}
    {#if form?.filesError}
      <p role="alert" data-files-error>{form.filesError}</p>
    {:else if form?.filesSaved}
      <p data-files-saved>
        {form.filesSaved.status === "committed"
          ? `Committed ${form.filesSaved.deployCommit?.slice(0, 7) ?? ""}: ${form.filesSaved.mounts.length} file(s) mounted.`
          : "Nothing to change."}
      </p>
    {/if}
  {/if}

  {#if data.storage}
    <h2>Storage</h2>
    <p>
      Persistent volumes this component writes to, each a claim of its own in <code>{data.storage.namespace ?? "its namespace"}</code>.
      With a volume, a Deployment rolls one pod at a time, the old one stopped first. Clearing a mount path unmounts the
      volume and keeps its data; data is deleted only with the confirmation below. Sizes can grow, not shrink.
    </p>
    <form method="POST" action="?/storage" data-storage>
      <table>
        <thead><tr><th>Name</th><th>Path in the container</th><th>Size</th><th>Storage class</th></tr></thead>
        <tbody>
          {#each [...data.storage.volumes, { name: "", mountPath: "", size: "1Gi", storageClass: "", claim: "", claimFile: true }] as v, i (i)}
            {@const isNew = i === data.storage.volumes.length}
            <tr data-storage-row={i}>
              <td>
                <input name={`volumes.${i}.name`} value={v.name} readonly={!isNew} placeholder="data" aria-label={`Name of volume ${i + 1}`} autocomplete="off" />
                {#if !isNew && !v.claimFile}<br /><small data-storage-elsewhere>claim {v.claim} is kept outside this directory</small>{/if}
              </td>
              <td>
                <input name={`volumes.${i}.mountPath`} value={v.mountPath} placeholder={isNew ? "/var/lib/app (add a volume)" : "clear to unmount"} aria-label={`Path of volume ${i + 1}`} autocomplete="off" />
              </td>
              <td><input name={`volumes.${i}.size`} value={v.size ?? "1Gi"} readonly={!isNew && !v.claimFile} size="6" aria-label={`Size of volume ${i + 1}`} /></td>
              <td><input name={`volumes.${i}.storageClass`} value={v.storageClass ?? ""} readonly={!isNew} placeholder="cluster default" aria-label={`Storage class of volume ${i + 1}`} /></td>
            </tr>
          {/each}
        </tbody>
      </table>
      <label>
        Group that owns the volumes (fsGroup):
        <input name="fsGroup" value={data.storage.fsGroup ?? ""} size="6" placeholder="none" inputmode="numeric" />
        <small>the image user's group id, if it is not root</small>
      </label>
      {#if data.storage.other.length > 0}
        <p>Claims this component mounts that stardust does not manage yet. Taking one over keeps the claim and its data:</p>
        <ul data-storage-other>
          {#each data.storage.other as o (o.volume)}
            <li><label><input type="checkbox" name="adopt" value={o.volume} /> {o.volume} → {o.mountPath ?? "not mounted"} (claim {o.claim})</label></li>
          {/each}
        </ul>
      {/if}
      {#if data.storage.kept.length > 0}
        <p>Unmounted, data kept. Add one again with its name to mount it, or delete its data:</p>
        <ul data-storage-kept>
          {#each data.storage.kept as k (k.name)}
            <li><label><input type="checkbox" name="deleteData" value={k.name} /> delete the data of {k.name} ({k.claim}, {k.size ?? "size unknown"})</label></li>
          {/each}
        </ul>
        <label><input type="checkbox" name="confirmDelete" /> I understand deleted data cannot be recovered</label>
      {/if}
      <button type="submit">Save storage</button>
    </form>
    {#if form?.storageError}
      <p role="alert" data-storage-error>{form.storageError}</p>
    {:else if form?.storageSaved}
      <p data-storage-saved>
        {form.storageSaved.status === "committed" ? `Committed ${form.storageSaved.deployCommit?.slice(0, 7) ?? ""}.` : "Nothing to change."}
      </p>
    {/if}
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
