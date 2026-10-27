<script lang="ts">
let { form } = $props();
</script>

<svelte:head>
  <title>Sign in · stardust</title>
</svelte:head>

<main>
  <h1>Sign in</h1>
  <form method="POST">
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
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {/if}
</main>
