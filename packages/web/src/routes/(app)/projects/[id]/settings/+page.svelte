<script lang="ts">
import ProjectForm from "$lib/components/ProjectForm.svelte";
import ProjectNav from "$lib/components/ProjectNav.svelte";

let { data, form } = $props();
</script>

<svelte:head>
  <title>Settings · {data.fields.id} · stardust</title>
</svelte:head>

<main>
  <div class="page-head"><h1>{data.fields.id}</h1></div>
  <ProjectNav projectId={data.fields.id} current="settings" isAdmin={true} />
  <ProjectForm
    fields={(form && "fields" in form ? form.fields : undefined) ?? data.fields}
    errors={(form && "errors" in form ? form.errors : undefined) ?? []}
    creating={false}
    deployDirTemplate={data.deployDirTemplate}
    action="?/save"
    access={form && "access" in form ? form.access : data.access}
  />

  <h2>Delete this project</h2>
  <p>
    Its runs and members are deleted; the audit log keeps its history. With the box ticked, its components'
    manifests are also removed from the deploy repository, and the GitOps controller removes what they deployed.
  </p>
  <form method="POST" action="?/delete" data-delete-project>
    <label>Type <code>{data.fields.id}</code> to confirm <input name="confirm" autocomplete="off" required /></label>
    <label><input type="checkbox" name="withdraw" /> Also remove its manifests from the deploy repository</label>
    <label>
      Your password, or a code from your app (when you signed in more than a few minutes ago)
      <input name="proof" type="password" autocomplete="current-password" />
    </label>
    <button type="submit">Delete</button>
  </form>
{#if data.sso}
  <form method="POST" action={`/login?/oidc&next=${encodeURIComponent(`/projects/${data.fields.id}/settings`)}`} data-reauth-sso>
    <input type="hidden" name="reauth" value="1" />
    <button type="submit">Signed in through single sign-on? Confirm there first</button>
  </form>
{/if}
  {#if form && "deleteError" in form}
    <p role="alert" data-delete-error>{form.deleteError}</p>
  {/if}
</main>
