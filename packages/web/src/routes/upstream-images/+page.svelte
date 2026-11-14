<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Upstream images · stardust</title>
</svelte:head>

<main>
  <h1>Upstream images</h1>
  <p>Mirrored components, and whether what they are pinned to has a newer release. Nothing changes here: edit the component to move its pin.</p>
  <form method="POST" action="?/check"><button type="submit">Check now</button></form>
  {#if form?.error}<p role="alert">{form.error}</p>{:else if form?.checked !== undefined}<p>Checked {form.checked}.</p>{/if}
  <table data-checks>
    <thead><tr><th>Component</th><th>Pinned</th><th>Newest</th><th>Checked</th></tr></thead>
    <tbody>
      {#each data.checks as c (`${c.projectId}/${c.component}`)}
        <tr data-newer={c.newer}>
          <td><a href={`/projects/${c.projectId}`}>{c.projectId}</a>/{c.component}</td>
          <td><code>{c.pinned.split("@")[0]}</code></td>
          <td>
            {#if c.error}<span>not checked: {c.error}</span>
            {:else if c.newer}<strong>{c.latestTag}</strong> <small><code>{c.latestDigest?.slice(0, 19)}…</code></small>
            {:else}up to date{/if}
          </td>
          <td>{new Date(c.checkedAt).toLocaleString()}</td>
        </tr>
      {:else}
        <tr><td colspan="4">No mirrored components, or not checked yet.</td></tr>
      {/each}
    </tbody>
  </table>
</main>
