<script lang="ts">
import ProjectForm from "$lib/components/ProjectForm.svelte";

let { data, form } = $props();
</script>

<svelte:head>
  <title>Settings · {data.fields.id} · stardust</title>
</svelte:head>

<main>
  <h1>{data.fields.id}: settings</h1>
  <p><a href={`/projects/${encodeURIComponent(data.fields.id)}`}>Back to runs</a></p>
  <ProjectForm fields={form?.fields ?? data.fields} errors={form?.errors ?? []} creating={false} />
</main>
