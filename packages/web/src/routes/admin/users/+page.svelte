<script lang="ts">
let { data, form } = $props();
</script>

<svelte:head>
  <title>Users · stardust</title>
</svelte:head>

<main>
  <h1>Users</h1>
  {#if form?.error}
    <p role="alert" data-users-error>{form.error}</p>
    {#if form.reauth}
      <form method="POST" action="/login?/oidc&next=/admin/users" data-reauth-sso>
        <input type="hidden" name="reauth" value="1" />
        <button type="submit">Confirm through single sign-on</button>
      </form>
      <form method="POST" action="?/reauth" data-reauth>
        <label>Your password, or a code from your app <input name="proof" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Confirm</button>
      </form>
    {/if}
  {:else if form?.confirmed}
    <p data-confirmed>Confirmed for the next few minutes.</p>
  {:else if form?.link}
    <div data-link>
      <p>Give this link to <strong>{form.link.username}</strong> to set their password. It works once, until {new Date(form.link.expiresAt).toLocaleString()}, and is not shown again:</p>
      <p><code>{form.link.url}</code></p>
    </div>
  {:else if form?.ended}
    <p data-ended>{form.ended.username}: ended {form.ended.sessions} session(s) and {form.ended.tokens} API token(s).</p>
  {/if}

  <table>
    <thead>
      <tr><th>User</th><th>Signs in with</th><th>Role</th><th>Projects</th><th></th></tr>
    </thead>
    <tbody>
      {#each data.users as u (u.id)}
        <tr data-user={u.username} data-disabled={u.disabled}>
          <td>{u.username}{u.displayName ? ` (${u.displayName})` : ""}{u.disabled ? " · disabled" : ""}</td>
          <td>{u.oidc ? "single sign-on" : u.hasPassword ? "password" : "not yet (invite)"}</td>
          <td>{u.isAdmin ? "administrator" : "member"}</td>
          <td>{u.roles.map((r) => `${r.projectId} (${r.role})`).join(", ") || "—"}</td>
          <td>
            {#if !u.oidc}
              <form method="POST" action="?/link">
                <input type="hidden" name="username" value={u.username} />
                <input type="hidden" name="purpose" value={u.hasPassword ? "reset" : "invite"} />
                <button type="submit">{u.hasPassword ? "Reset link" : "Invite link"}</button>
              </form>
            {/if}
            {#if u.username !== data.me}
              <form method="POST" action="?/update">
                <input type="hidden" name="username" value={u.username} />
                <input type="hidden" name="isAdmin" value={u.isAdmin ? "false" : "true"} />
                <button type="submit">{u.isAdmin ? "Make member" : "Make administrator"}</button>
              </form>
              <form method="POST" action="?/update">
                <input type="hidden" name="username" value={u.username} />
                <input type="hidden" name="disabled" value={u.disabled ? "false" : "true"} />
                <button type="submit">{u.disabled ? "Enable" : "Disable"}</button>
              </form>
            {/if}
            <form method="POST" action="?/resetTotp">
              <input type="hidden" name="username" value={u.username} />
              <button type="submit" title="After a lost phone">Reset two-step sign-in</button>
            </form>
            <form method="POST" action="?/endSessions">
              <input type="hidden" name="username" value={u.username} />
              <button type="submit">End sessions</button>
            </form>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h2>Add a user</h2>
  <p>A new account gets an invitation link to set its password. People who sign in through single sign-on are added at their first sign-in when the server allows it.</p>
  <form method="POST" action="?/create" data-create-user>
    <label>Username <input name="username" required pattern={"[a-z0-9][a-z0-9._-]{0,62}"} autocomplete="off" /></label>
    <label>Display name <input name="displayName" /></label>
    <label><input type="checkbox" name="isAdmin" /> Administrator</label>
    <button type="submit">Add and invite</button>
  </form>
</main>

<style>
  table {
    border-collapse: collapse;
  }
  td,
  th {
    padding: 0.25rem 0.75rem;
    text-align: left;
    vertical-align: top;
  }
  td form {
    display: inline;
  }
</style>
