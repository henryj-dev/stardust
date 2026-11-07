<script lang="ts">
import ProjectForm from "$lib/components/ProjectForm.svelte";

let { data, form } = $props();
</script>

<svelte:head>
  <title>New project · stardust</title>
</svelte:head>

<main>
  <h1>New project</h1>
  <ProjectForm fields={form?.fields ?? data.fields} errors={form?.errors ?? []} creating={true} />
</main>
