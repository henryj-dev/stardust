<script lang="ts">
let { form } = $props();
</script>

<svelte:head>
  <title>Sign in · stardust</title>
</svelte:head>

<main>
  <h1>Sign in</h1>
  <p>Until user accounts exist, sign in with the admin token from stardust.yaml.</p>
  <form method="POST">
    <label>
      Admin token
      <input name="token" type="password" autocomplete="current-password" required />
    </label>
    <button type="submit">Sign in</button>
  </form>
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {/if}
</main>
