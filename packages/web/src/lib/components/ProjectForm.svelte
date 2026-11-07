<script lang="ts">
import { untrack } from "svelte";
import { type ComponentFields, emptyComponent, type ProjectFields } from "$lib/project-fields";

let { fields, errors, creating }: { fields: ProjectFields; errors: string[]; creating: boolean } = $props();

const copy = (f: ProjectFields): ComponentFields[] => f.components.map((c) => ({ ...c }));
// Filled before the first render so the rows are in the server's HTML (the form works without JavaScript),
// then refilled when the page gets other fields (a refused save, another project).
let components = $state<ComponentFields[]>(untrack(() => copy(fields)));
$effect(() => {
  components = copy(fields);
});
</script>

{#if errors.length > 0}
  <div role="alert" data-errors>
    <p>The project was not saved:</p>
    <ul>
      {#each errors as e (e)}<li>{e}</li>{/each}
    </ul>
  </div>
{/if}

<form method="POST" data-project-form>
  <label>
    Id
    {#if creating}
      <input name="id" value={fields.id} required pattern="[a-z][a-z0-9\-]{'{0,62}'}" autocomplete="off" />
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

  <fieldset>
    <legend>Components</legend>
    {#each components as component, i (i)}
      <fieldset data-component={i}>
        <legend>Component {i + 1}</legend>
        <label>Name <input name={`components.${i}.name`} bind:value={component.name} required /></label>
        <label>
          Pipeline
          <select name={`components.${i}.pipeline`} bind:value={component.pipeline}>
            <option value="C">C: the repository's Dockerfile</option>
            <option value="N">N: a Node app, no Dockerfile needed</option>
            <option value="W">W</option>
          </select>
        </label>
        <label>Build context <input name={`components.${i}.context`} bind:value={component.context} placeholder="repository root" /></label>
        {#if component.pipeline === "N"}
          <label>Port <input name={`components.${i}.port`} bind:value={component.port} inputmode="numeric" placeholder="3000" /></label>
          <label>
            Build environment
            <textarea name={`components.${i}.buildEnv`} bind:value={component.buildEnv} rows="3" placeholder="KEY=value, one per line. Not for secrets."></textarea>
          </label>
        {:else}
          <label>Dockerfile <input name={`components.${i}.dockerfile`} bind:value={component.dockerfile} placeholder="Dockerfile" /></label>
        {/if}
        <label>Deploy directory <input name={`components.${i}.deployDir`} bind:value={component.deployDir} required placeholder="path in the deploy repository" /></label>
        <button type="button" onclick={() => components.splice(i, 1)}>Remove component</button>
      </fieldset>
    {/each}
    <button type="button" onclick={() => components.push(emptyComponent())} data-add-component>Add component</button>
  </fieldset>

  <button type="submit">{creating ? "Create project" : "Save"}</button>
</form>
