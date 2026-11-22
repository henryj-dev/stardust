<script lang="ts">
import { page } from "$app/state";
import PageContainer from "$lib/components/layout/PageContainer.svelte";
import PageHeader from "$lib/components/layout/PageHeader.svelte";
import Button from "$lib/components/ui/Button.svelte";
import TextField from "$lib/components/ui/TextField.svelte";
import CreateUserDialog from "$lib/components/users/CreateUserDialog.svelte";
import SignInSettings from "$lib/components/users/SignInSettings.svelte";
import UserList from "$lib/components/users/UserList.svelte";
import WaitingList from "$lib/components/users/WaitingList.svelte";

let { data, form } = $props();
const createError = $derived(page.url.searchParams.has("/create") && form?.error && !form.reauth ? form.error : null);
</script>

<svelte:head><title>Users · stardust</title></svelte:head>

<PageContainer>
  <PageHeader title="Users">
    {#snippet actions()}<CreateUserDialog error={createError} sso={data.sso} />{/snippet}
  </PageHeader>

  {#if form?.error && !createError}
    <div class="mb-5 rounded-xl bg-[#fff1f1] p-4 text-sm text-[#b4232e]" role="alert" data-users-error>
      <p class="m-0">{form.error}</p>
    </div>
    {#if form.reauth}
      {#if data.sso}
        <form method="POST" action="/login?/oidc&next=/admin/users" data-reauth-sso class="mb-4"><input type="hidden" name="reauth" value="1" /><Button type="submit" variant="secondary" size="compact" fullWidth={false}>Confirm through single sign-on</Button></form>
      {/if}
      <form method="POST" action="?/reauth" data-reauth class="mb-5 grid max-w-md gap-3"><TextField id="users-reauth" label="Your password, or a code from your app" name="proof" type="password" autocomplete="current-password" required /><Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Confirm</Button></form>
    {/if}
  {:else if form?.confirmed}
    <p data-confirmed class="mb-5 text-sm text-[#287345]">Confirmed for the next few minutes.</p>
  {:else if form?.link}
    <div data-link class="mb-5 rounded-xl bg-[#f4f6f9] p-4 text-sm text-[#44454a]">
      <p>Give this link to <strong>{form.link.username}</strong> to set their password. It works once, until {new Date(form.link.expiresAt).toLocaleString()}, and is not shown again:</p>
      <p class="mb-0 break-all"><code>{form.link.url}</code></p>
    </div>
  {:else if form?.ended}
    <p data-ended class="mb-5 text-sm text-[#44454a]">{form.ended.username}: ended {form.ended.sessions} session(s) and {form.ended.tokens} API token(s).</p>
  {:else if form?.created}
    <p data-created class="mb-5 text-sm text-[#287345]">Added <strong>{form.created.username}</strong>: they sign in through single sign-on.</p>
  {/if}

  {#if data.signIn?.oidc}<SignInSettings settings={data.signIn} saved={form?.signInSaved === true} />{/if}
  <WaitingList waiting={data.waiting} users={data.users} />
  <UserList users={data.users} me={data.me} sso={data.sso} />
</PageContainer>
