<script lang="ts">
let { form } = $props();
</script>

<svelte:head>
  <title>Set your password · stardust</title>
  <meta name="referrer" content="no-referrer" />
</svelte:head>

<main>
  <h1>Set your password</h1>
  <p>This link works once. At least 12 characters.</p>
  {#if form?.error}<p role="alert" data-link-error>{form.error}</p>{/if}
  <form method="POST" data-set-password>
    <label>Password <input type="password" name="password" autocomplete="new-password" minlength="12" required /></label>
    <label>Again <input type="password" name="again" autocomplete="new-password" minlength="12" required /></label>
    <button type="submit">Set password</button>
  </form>
</main>
