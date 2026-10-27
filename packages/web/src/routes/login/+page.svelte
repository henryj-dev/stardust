<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Sign in · stardust</title>
</svelte:head>

<main>
  <h1>Sign in</h1>
  {#if data.oidc}
    <form method="POST" action="?/oidc">
      <button type="submit">Sign in with {data.oidc.displayName}</button>
    </form>
    <p>or with a password:</p>
  {/if}
  <!-- The action replaces the query string, so `next` is carried along explicitly. -->
  <form method="POST" action={`?/password&next=${encodeURIComponent(data.next)}`}>
    <label>
      Username
      <input name="username" autocomplete="username" value={form?.username ?? ""} required />
    </label>
    <label>
      Password
      <input name="password" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit">Sign in</button>
  </form>
  {#if form?.error ?? data.error}
    <p role="alert">{form?.error ?? data.error}</p>
  {/if}
</main>
