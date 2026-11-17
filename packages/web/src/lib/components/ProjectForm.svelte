<script lang="ts">
import { untrack } from "svelte";
import { suggestedDir } from "$lib/deploy-dir";
import { type ComponentFields, emptyComponent, type ProjectFields } from "$lib/project-fields";
import { type AccessView, accessNote } from "$lib/source-access";

let {
  fields,
  errors,
  creating,
  action,
  access = null,
  deployDirTemplate = null,
}: {
  fields: ProjectFields;
  errors: string[];
  creating: boolean;
  action?: string;
  access?: AccessView | null;
  /** The server's default deploy directory, filled in while the names are typed. */
  deployDirTemplate?: string | null;
} = $props();
// The id as typed, for the suggested directories.
let projectId = $state(untrack(() => fields.id));
// A directory someone typed is theirs; one left empty follows the names.
type Row = ComponentFields & { dirTyped: boolean };
// What stardust can do with the repository, when it was asked.
const note = $derived(access ? accessNote(access) : null);

const copy = (f: ProjectFields): Row[] => f.components.map((c) => ({ ...c, dirTyped: c.deployDir !== "" }));
// Filled before the first render so the rows are in the server's HTML (the form works without JavaScript),
// then refilled when the page gets other fields (a refused save, another project).
let components = $state<Row[]>(untrack(() => copy(fields)));
$effect(() => {
  components = copy(fields);
  projectId = fields.id;
});
const dirOf = (c: Row) => (c.dirTyped ? c.deployDir : suggestedDir(deployDirTemplate, projectId, c.name));
</script>

{#if errors.length > 0}
  <div role="alert" data-errors>
    <p>The project was not saved:</p>
    <ul>
      {#each errors as e (e)}<li>{e}</li>{/each}
    </ul>
  </div>
{/if}

<form method="POST" {action} data-project-form>
  <div class="fields">
  <label>
    Id
    {#if creating}
      <input name="id" bind:value={projectId} required pattern="[a-z][a-z0-9\-]{'{0,62}'}" autocomplete="off" />
      <small>Lower-case letters, digits and dashes, starting with a letter. It cannot be changed later.</small>
    {:else}
      <code>{fields.id}</code>
    {/if}
  </label>
  <label>
    Name
    <input name="name" value={fields.name} placeholder="the id" />
  </label>
  <label>
    Repository
    <input name="githubRepo" value={fields.githubRepo} placeholder="owner/name" autocomplete="off" />
  </label>
  </div>
  <button type="submit" formaction="?/check" formnovalidate data-check-access>Check access</button>
  {#if note}
    <p data-access={note.warn ? "warn" : "ok"} role={note.warn ? "alert" : "status"}>{note.text}</p>
  {/if}

  <fieldset>
    <legend>Components</legend>
    {#each components as component, i (i)}
      <fieldset data-component={i}>
        <legend>Component {i + 1}</legend>
        <div class="fields">
        <label>Name <input name={`components.${i}.name`} bind:value={component.name} required /></label>
        <label>
          Pipeline
          <select name={`components.${i}.pipeline`} bind:value={component.pipeline}>
            <option value="C">C: the repository's Dockerfile</option>
            <option value="N">N: a Node app, no Dockerfile needed</option>
            <option value="M">M: copy a published image, build nothing</option>
            <option value="W">W</option>
          </select>
        </label>
        {#if component.pipeline === "M"}
          <label>
            Published image
            <input
              name={`components.${i}.image`}
              bind:value={component.image}
              required
              autocomplete="off"
              placeholder="docker.io/org/app:1.2@sha256:…"
            />
            <small>Pinned by digest. Each delivery copies exactly this image into the registry and runs none of its code; change the digest to move to another release.</small>
          </label>
        {:else}
        <label>Build context <input name={`components.${i}.context`} bind:value={component.context} placeholder="repository root" /></label>
        {/if}
        {#if component.pipeline === "M"}
          <!-- Nothing is built. -->
        {:else if component.pipeline === "N"}
          <label>Port <input name={`components.${i}.port`} bind:value={component.port} inputmode="numeric" placeholder="3000" /></label>
          <label>
            Build environment
            <textarea name={`components.${i}.buildEnv`} bind:value={component.buildEnv} rows="3" placeholder="KEY=value, one per line. Not for secrets."></textarea>
          </label>
        {:else}
          <label>Dockerfile <input name={`components.${i}.dockerfile`} bind:value={component.dockerfile} placeholder="Dockerfile" /></label>
        {/if}
        </div>
        <label>
          Deploy directory
          <input
            name={`components.${i}.deployDir`}
            value={dirOf(component)}
            oninput={(e) => {
              component.deployDir = e.currentTarget.value;
              component.dirTyped = e.currentTarget.value !== "";
            }}
            required={!deployDirTemplate}
            placeholder={deployDirTemplate ? deployDirTemplate : "path in the deploy repository"}
          />
          {#if deployDirTemplate && !component.dirTyped}
            <small data-dir-suggested>Filled from the id and the component's name; type to choose another.</small>
          {/if}
        </label>
        <button type="button" onclick={() => components.splice(i, 1)}>Remove component</button>
      </fieldset>
    {/each}
    <button type="button" onclick={() => components.push({ ...emptyComponent(), dirTyped: false })} data-add-component
      >Add component</button
    >
  </fieldset>

  <button type="submit">{creating ? "Create project" : "Save"}</button>
</form>
