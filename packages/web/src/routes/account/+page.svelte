<script lang="ts">
let { data, form } = $props();
const time = (iso: string) => new Date(iso).toLocaleString();
</script>

<svelte:head>
  <title>Your account · stardust</title>
</svelte:head>

<main>
  <h1>Your account</h1>

  <h2>Password</h2>
  {#if form?.passwordError}
    <p role="alert" data-password-error>{form.passwordError}</p>
  {:else if form?.changed}
    <p data-password-changed>Changed. Your other sessions and your API tokens have ended.</p>
  {/if}
  <form method="POST" action="?/password" data-password>
    <label>Current password <input type="password" name="current" autocomplete="current-password" required /></label>
    <label>New password <input type="password" name="password" autocomplete="new-password" minlength="12" required /></label>
    <label>Again <input type="password" name="again" autocomplete="new-password" minlength="12" required /></label>
    <button type="submit">Change password</button>
  </form>

  <h2>Sessions</h2>
  {#if form?.sessionError}<p role="alert">{form.sessionError}</p>{/if}
  <table>
    <thead><tr><th>Started</th><th>Last seen</th><th>Signed in with</th><th></th></tr></thead>
    <tbody>
      {#each data.sessions as s (s.id)}
        <tr data-session={s.id}>
          <td>{time(s.createdAt)}</td>
          <td>{time(s.lastSeenAt)}</td>
          <td>{s.via === "oidc" ? "single sign-on" : "password"}</td>
          <td>
            {#if s.current}
              this one
            {:else}
              <form method="POST" action="?/end">
                <input type="hidden" name="session" value={s.id} />
                <button type="submit">End</button>
              </form>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</main>
