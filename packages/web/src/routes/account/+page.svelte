<script lang="ts">
let { data, form } = $props();
const time = (iso: string) => new Date(iso).toLocaleString();
const ended = (iso: string) => new Date(iso).getTime() <= Date.now();

let copied = $state(false);
async function copy(value: string) {
  await navigator.clipboard.writeText(value);
  copied = true;
}
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

  <h2>Two-step sign-in</h2>
  {#if form?.totpError}<p role="alert" data-totp-error>{form.totpError}</p>{/if}
  {#if form?.recoveryCodes}
    <div data-recovery-codes>
      <p>Your recovery codes. Each works once, in place of a code, if you lose your phone. Keep them somewhere safe: they are not shown again.</p>
      <pre>{form.recoveryCodes.join("\n")}</pre>
    </div>
  {/if}
  {#if data.totp.policy === "off"}
    <p>Two-step sign-in is off on this server.</p>
  {:else if form?.setup}
    <p>Add this to your authenticator app, then enter the code it shows.</p>
    <p>Secret: <code data-totp-secret>{form.setup.secret}</code></p>
    <p>Or open this link on the phone: <code>{form.setup.uri}</code></p>
    <form method="POST" action="?/totpConfirm">
      <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" required /></label>
      <button type="submit">Turn on</button>
    </form>
  {:else if data.totp.enrolled && !form?.totpOff}
    <p data-totp-on>On. {data.totp.recoveryCodesLeft} recovery code(s) left.</p>
    <form method="POST" action="?/totpCodes">
      <label>Code from your app <input name="code" inputmode="numeric" autocomplete="one-time-code" required /></label>
      <button type="submit">New recovery codes</button>
    </form>
    {#if data.totp.policy !== "required"}
      <form method="POST" action="?/totpOff">
        <label>Code (or a recovery code) <input name="code" autocomplete="one-time-code" required /></label>
        <button type="submit">Turn off</button>
      </form>
    {/if}
  {:else}
    <p data-totp-off>{data.totp.policy === "required" ? "Required on this server: set it up to continue." : "Off."}</p>
    <form method="POST" action="?/totpSetup"><button type="submit">Set up</button></form>
  {/if}

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

  <h2>API tokens</h2>
  <p>For scripts and automation. A token acts with your roles until it expires or you revoke it.</p>
  {#if form?.tokenError}
    <p role="alert" data-token-error>{form.tokenError}</p>
    {#if form.reauth}
{#if data.sso}
      <form method="POST" action="/login?/oidc&next=/account" data-reauth-sso>
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
  {:else if form?.revokedToken}
    <p data-token-revoked>Revoked. It no longer works.</p>
  {/if}
  {#if form?.createdToken}
    <div data-new-token>
      <p>Your new token <strong>{form.createdToken.name}</strong>. Copy it now: it is not shown again.</p>
      <p><code data-token-value>{form.createdToken.token}</code></p>
      <button type="button" onclick={() => form?.createdToken && copy(form.createdToken.token)}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  {/if}
  {#if data.tokens.length === 0}
    <p data-no-tokens>No tokens.</p>
  {:else}
    <table>
      <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
      <tbody>
        {#each data.tokens as t (t.id)}
          <tr data-token={t.id}>
            <td>{t.name}</td>
            <td>{time(t.createdAt)}</td>
            <td>{t.lastUsedAt ? time(t.lastUsedAt) : "never"}</td>
            <td>{t.expiresAt ? `${ended(t.expiresAt) ? "ended " : ""}${time(t.expiresAt)}` : "never"}</td>
            <td>
              <form method="POST" action="?/revokeToken">
                <input type="hidden" name="token" value={t.id} />
                <button type="submit">Revoke</button>
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  <form method="POST" action="?/createToken" data-create-token>
    <label>Name <input name="name" maxlength="100" autocomplete="off" required value={form?.tokenName ?? ""} /></label>
    <label>
      Expires after
      <select name="expiry">
        {#each data.tokenExpiry.choices as c (c.value)}
          <option value={c.value} selected={c.value === (form?.tokenExpiry ?? data.tokenExpiry.default)}>{c.label}</option>
        {/each}
      </select>
    </label>
    <button type="submit">Make a token</button>
  </form>
</main>
