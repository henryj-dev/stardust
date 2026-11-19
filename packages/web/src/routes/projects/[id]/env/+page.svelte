<script lang="ts">
import ProjectNav from "$lib/components/ProjectNav.svelte";

let { data, form } = $props();

const title = (layer: string) => (layer === "_shared" ? "Every component" : layer);
const confirmRemove = (e: SubmitEvent, name: string) => {
  if (!confirm(`Remove ${name}? The workloads that use it roll out without it.`)) e.preventDefault();
};
const isLiteral = (layer: { literal?: string[] }, name: string) => (layer.literal ?? []).includes(name);
const revealed = (layer: string, name: string) =>
  form?.revealed && form.revealed.layer === layer && form.revealed.name === name ? form.revealed.value : null;
</script>

<svelte:head>
  <title>Env · {data.projectId} · stardust</title>
</svelte:head>

<main>
  <div class="page-head"><h1>{data.projectId}</h1></div>
  <ProjectNav projectId={data.projectId} current="env" isAdmin={data.user?.isAdmin === true} />
  {#if data.off}
    <p data-env-off>{data.off}. An administrator enables it by giving the server the deploy repository and SOPS.</p>
  {:else if data.env}
    <p>
      Each change is one commit to the deploy repository; the workloads that use the env roll out when it is applied.
      A value can use others: <code>{"${NAME}"}</code> is NAME as the component ends up with it,
      <code>{"{{project.NAME}}"}</code> is NAME for every component, and <code>{"$${"}</code> is a plain
      <code>{"${"}</code>. Literal keeps a value exactly as written. A plain value cannot use a secret. Secrets are
      hidden; people who can change them can show one, and every showing is in the audit log.
    </p>
    {#if form?.error}
      <p role="alert" data-env-error>{form.layer ? `${title(form.layer)}: ` : ""}{form.name ? `${form.name}: ` : ""}{form.error}</p>
    {:else if form?.result}
      <p data-env-result>
        {#if form.result.status === "no_change"}
          Nothing changed{form.name ? `: ${form.name} already had that value` : ""}.
        {:else}
          Committed <code>{form.result.commit?.slice(0, 12)}</code>.
          {#if (form.result.adopted ?? []).length > 0}
            Moved in: {(form.result.adopted ?? []).map((h) => `${h.kind} ${h.name}`).join(", ")}.
          {/if}
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
      {@const hand = (data.env.adoptable ?? []).filter((h) => h.component === layer.layer)}
      <section data-env-layer={layer.layer}>
        <h2>{title(layer.layer)}</h2>
        {#if hand.length > 0}
          <div data-env-adoptable={layer.layer}>
            <p>
              <strong>Made by hand:</strong>
              {#each hand as h, i (h.path + h.name)}{i > 0 ? "; " : ""}{h.kind} <code>{h.name}</code> in
                <code>{h.path.split("/").pop()}</code> ({h.keys.join(", ")}){/each}.
              stardust renders objects by these names, so the next change here moves their values into this layer and
              takes them out of those files, in the same commit. Values already in this layer are kept.
            </p>
            {#if data.env.canEdit}
              <form method="POST" action="?/adopt">
                <input type="hidden" name="layer" value={layer.layer} />
                <input type="hidden" name="revision" value={layer.revision} />
                <button type="submit">Move them now</button>
              </form>
            {/if}
          </div>
        {/if}
        {#if Object.keys(layer.plain).length === 0 && layer.secrets.length === 0}
          <p>No values.</p>
        {:else}
          <table>
            <thead><tr><th>Name</th><th>Value</th>{#if data.env.canEdit}<th></th>{/if}</tr></thead>
            <tbody>
              {#each Object.entries(layer.plain) as [name, value] (name)}
                <tr data-env-plain={name}>
                  <td>
                    <code>{name}</code>
                    {#if isLiteral(layer, name)}<br /><small data-env-literal>literal</small>{/if}
                  </td>
                  <td>
                    {#if value.includes("\n")}<pre data-env-multiline>{value}</pre>{:else}<code>{value}</code>{/if}
                  </td>
                  {#if data.env.canEdit}
                    <td>
                      <details data-env-edit={name}>
                        <summary>Edit</summary>
                        <form method="POST" action="?/set" enctype="multipart/form-data">
                          <input type="hidden" name="layer" value={layer.layer} />
                          <input type="hidden" name="revision" value={layer.revision} />
                          <input type="hidden" name="name" value={name} />
                          <input type="hidden" name="kind" value="plain" />
                          {#if isLiteral(layer, name)}<input type="hidden" name="wasLiteral" value="on" />{/if}
                          <textarea name="value" rows={Math.min(12, value.split("\n").length + 1)} autocomplete="off"
                            spellcheck="false" aria-label={`Value of ${name}`}>{value}</textarea>
                          <label><input type="checkbox" name="literal" checked={isLiteral(layer, name)} /> Literal</label>
                          <label><input type="checkbox" name="public" /> The value is public</label>
                          <button type="submit">Save</button>
                        </form>
                      </details>
                      <form method="POST" action="?/literal">
                        <input type="hidden" name="layer" value={layer.layer} />
                        <input type="hidden" name="revision" value={layer.revision} />
                        <input type="hidden" name="name" value={name} />
                        {#if !isLiteral(layer, name)}<input type="hidden" name="literal" value="on" />{/if}
                        <button type="submit">{isLiteral(layer, name) ? "Resolve references" : "Make literal"}</button>
                      </form>
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
                {@const shown = revealed(layer.layer, name)}
                <tr data-env-secret={name}>
                  <td>
                    <code>{name}</code>
                    {#if isLiteral(layer, name)}<br /><small data-env-literal>literal</small>{/if}
                  </td>
                  <td>
                    {#if shown !== null}
                      <textarea readonly rows={Math.min(12, shown.split("\n").length + 1)} data-env-revealed
                        aria-label={`Value of ${name}`}>{shown}</textarea>
                      <br /><a href="?" data-env-hide>Hide</a>
                    {:else}
                      <em>secret, set</em>
                    {/if}
                  </td>
                  {#if data.env.canEdit}
                    <td>
                      {#if shown === null}
                        <form method="POST" action="?/reveal">
                          <input type="hidden" name="layer" value={layer.layer} />
                          <input type="hidden" name="name" value={name} />
                          <button type="submit" data-env-show>Show</button>
                        </form>
                      {/if}
                      <form method="POST" action="?/set" enctype="multipart/form-data">
                        <input type="hidden" name="layer" value={layer.layer} />
                        <input type="hidden" name="revision" value={layer.revision} />
                        <input type="hidden" name="name" value={name} />
                        <input type="hidden" name="kind" value="secret" />
                        {#if isLiteral(layer, name)}<input type="hidden" name="wasLiteral" value="on" />{/if}
                        <!-- Shown, the value is here to edit; hidden, the field is empty and a new value replaces it. -->
                        <textarea name="value" rows={shown === null ? 2 : Math.min(12, shown.split("\n").length + 1)}
                          autocomplete="off" spellcheck="false" aria-label={`New value for ${name}`}
                          placeholder="new value (several lines are fine)">{shown ?? ""}</textarea>
                        <input type="file" name="file" aria-label={`Or a file for ${name}`} />
                        <label><input type="checkbox" name="literal" checked={isLiteral(layer, name)} /> Literal</label>
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
          <form method="POST" action="?/set" enctype="multipart/form-data" data-env-add>
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
            <!-- Several lines are kept exactly, a trailing newline included. -->
            <label>Value <textarea name="value" rows="3" autocomplete="off" spellcheck="false"></textarea></label>
            <!-- A key, a JSON credential or a config file: its text is the value, newlines and all. -->
            <label data-env-file>Or a file (UTF-8 text, up to 32 KiB) <input type="file" name="file" /></label>
            <label data-env-literal-add
              ><input type="checkbox" name="literal" /> Literal (keep <code>{"${…}"}</code> and
              <code>{"{{project.…}}"}</code> as written)</label
            >
            <!-- Plain values are committed to Git; one whose name looks secret is refused unless this is ticked. -->
            <label data-env-public
              ><input type="checkbox" name="public" /> The value is public (a plain value whose name looks like a secret's)</label
            >
            <button type="submit">Save</button>
          </form>
        {/if}
      </section>
    {/each}
  {/if}
</main>
