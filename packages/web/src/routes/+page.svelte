<script lang="ts">
let { data } = $props();
</script>

<svelte:head>
  <title>Projects · stardust</title>
</svelte:head>

<main>
  <h1>Projects</h1>
  {#if data.user?.isAdmin}
    <p><a href="/admin/projects/new" data-new-project>New project</a></p>
  {/if}
  {#if data.projects.length === 0}
    <p>No projects you can see yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Project</th><th>Repository</th><th>Last run</th><th>Ref</th><th>Commit</th><th>Status</th>{#if data.user?.isAdmin}<th></th>{/if}</tr>
      </thead>
      <tbody>
        {#each data.projects as project (project.id)}
          <tr data-project={project.id}>
            <td><a href={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</a></td>
            <td>{project.githubRepo ?? "—"}</td>
            {#if project.lastRun}
              <td>
                <a
                  href={`/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(project.lastRun.id)}`}
                  data-run-link>{new Date(project.lastRun.createdAt).toLocaleString()}</a
                >
                {#if project.lastRun.requestedBy}<br /><small>pulled by {project.lastRun.requestedBy}</small>{/if}
              </td>
              <td>{project.lastRun.ref}</td>
              <td><code>{project.lastRun.sha.slice(0, 7)}</code></td>
              <td data-status={project.lastRun.status}>{project.lastRun.status}</td>
            {:else}
              <td colspan="4">No runs yet.</td>
            {/if}
            {#if data.user?.isAdmin}
              <td><a href={`/projects/${encodeURIComponent(project.id)}/settings`} data-edit-project>Edit</a></td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>
