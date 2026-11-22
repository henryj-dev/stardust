<script lang="ts">
let { data, form } = $props();

/** Accounts single sign-on could still be linked to. */
const unlinked = $derived(data.users.filter((u) => !u.oidc));
/** A username stardust accepts, from what the provider said; the administrator can change it. */
const suggest = (r: { username: string | null; email: string | null }) =>
  (r.username ?? r.email?.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
</script>

<svelte:head>
  <title>Users · stardust</title>
</svelte:head>

<main>
  <h1>Users</h1>
  {#if form?.error}
    <p role="alert" data-users-error>{form.error}</p>
    {#if form.reauth}
{#if data.sso}
      <form method="POST" action="/login?/oidc&next=/admin/users" data-reauth-sso>
        <input type="hidden" name="reauth" value="1" />
        <button type="submit">Confirm through single sign-on</button>
      </form>
{/if}
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
  {:else if form?.created}
    <p data-created>Added <strong>{form.created.username}</strong>: they sign in through single sign-on.</p>
  {/if}

  {#if data.waiting.length > 0}
    <h2>Waiting to be let in</h2>
    <p>
      People the provider signed in who have no account here, from the audit log. Give one an account, or link them
      to an account that exists.
    </p>
    <table data-waiting>
      <thead>
        <tr><th>Last tried</th><th>Who the provider says</th><th>Why turned away</th><th></th></tr>
      </thead>
      <tbody>
        {#each data.waiting as r (r.issuer + " " + r.subject)}
          <tr data-waiting-subject={r.subject}>
            <td>{new Date(r.at).toLocaleString()}{r.attempts > 1 ? ` (${r.attempts} tries)` : ""}</td>
            <td>
              {[r.name, r.username, r.email].filter(Boolean).join(" · ") || "nothing said"}
              <br /><small>subject <code>{r.subject}</code></small>
            </td>
            <td>{r.reason === "no-account" ? "no account" : "their username belongs to another account"}</td>
            <td>
              <form method="POST" action="?/create" data-waiting-create>
                <input type="hidden" name="subject" value={r.subject} />
                <input
                  name="username"
                  value={suggest(r)}
                  required
                  pattern={"[a-z0-9][a-z0-9._-]{0,62}"}
                  aria-label="Username"
                  autocomplete="off"
                />
                <input type="hidden" name="displayName" value={r.name ?? ""} />
                <label><input type="checkbox" name="isAdmin" /> Administrator</label>
                <button type="submit">Give an account</button>
              </form>
              {#if unlinked.length > 0}
                <form method="POST" action="?/sso" data-waiting-link>
                  <input type="hidden" name="subject" value={r.subject} />
                  <select name="username" aria-label="Account" required>
                    {#each unlinked as u (u.id)}<option value={u.username}>{u.username}</option>{/each}
                  </select>
                  <button type="submit">Link to this account</button>
                </form>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <table>
    <thead>
      <tr><th>User</th><th>Signs in with</th><th>Role</th><th>Projects</th><th></th></tr>
    </thead>
    <tbody>
      {#each data.users as u (u.id)}
        <tr data-user={u.username} data-disabled={u.disabled}>
          <td>{u.username}{u.displayName ? ` (${u.displayName})` : ""}{u.disabled ? " · disabled" : ""}</td>
          <td>
            {u.oidc ? "single sign-on" : u.hasPassword ? "password" : "not yet (invite)"}
            {#if u.oidc}
              <br /><small>subject <code>{u.oidc.subject}</code></small>
              <form method="POST" action="?/sso" data-sso-unlink>
                <input type="hidden" name="username" value={u.username} />
                <input type="hidden" name="op" value="unlink" />
                <button type="submit">Unlink</button>
              </form>
            {:else if data.sso}
              <form method="POST" action="?/sso" data-sso-link>
                <input type="hidden" name="username" value={u.username} />
                <input name="subject" placeholder="single sign-on subject" aria-label="Single sign-on subject" required autocomplete="off" />
                <button type="submit">Link</button>
              </form>
            {/if}
          </td>
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
  <p>
    A new account gets an invitation link to set its password. With a single sign-on subject it signs in through the
    provider instead, and gets no link. People who sign in through single sign-on are also added at their first
    sign-in when the server allows it, or wait above to be let in.
  </p>
  <form method="POST" action="?/create" data-create-user>
    <label>Username <input name="username" required pattern={"[a-z0-9][a-z0-9._-]{0,62}"} autocomplete="off" /></label>
    <label>Display name <input name="displayName" /></label>
    {#if data.sso}
      <label>
        Single sign-on subject <input name="subject" autocomplete="off" />
        <small>optional: the person signs in through the provider</small>
      </label>
    {/if}
    <label><input type="checkbox" name="isAdmin" /> Administrator</label>
    <button type="submit">Add</button>
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
