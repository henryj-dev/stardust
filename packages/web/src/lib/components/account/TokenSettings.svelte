<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";
import SelectField from "$lib/components/ui/SelectField.svelte";
import TextField from "$lib/components/ui/TextField.svelte";
import type { ActionData, PageData } from "../../../routes/(app)/account/$types";
import SettingsCard from "./SettingsCard.svelte";

let { data, form }: { data: PageData; form: ActionData | null } = $props();
const time = (iso: string) => new Date(iso).toLocaleString();
const ended = (iso: string) => new Date(iso).getTime() <= Date.now();
let copied = $state(false);
let copyError = $state(false);
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    copied = true;
    copyError = false;
  } catch {
    copyError = true;
  }
}
</script>

<SettingsCard id="tokens" title="API tokens" description="Manage tokens for scripts and automation.">
  {#if form?.tokenError}
    <p role="alert" data-token-error>{form.tokenError}</p>
    {#if form.reauth}
{#if data.sso}
      <form method="POST" action="/login?/oidc&next=%2Faccount%23tokens" data-reauth-sso>
        <input type="hidden" name="reauth" value="1" />
        <Button type="submit" size="compact" fullWidth={false} variant="secondary" class="justify-self-end">Confirm through single sign-on</Button>
      </form>
{/if}
      <form method="POST" action="?/reauth#tokens" data-reauth>
        <TextField id="reauth-proof" label="Your password, or a code from your app" name="proof" type="password" autocomplete="current-password" required />
        <Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Confirm</Button>
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
      <Button size="compact" variant="secondary" fullWidth={false} onclick={() => form?.createdToken && copy(form.createdToken.token)}>{copied ? "Copied" : "Copy"}</Button>
      {#if copyError}<p role="alert">Could not copy. Select the token above and copy it manually.</p>{/if}
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
              <form method="POST" action="?/revokeToken#tokens">
                <input type="hidden" name="token" value={t.id} />
                <Button type="submit" size="compact" fullWidth={false} variant="danger" class="justify-self-end">Revoke</Button>
              </form>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
  <form method="POST" action="?/createToken#tokens" data-create-token>
    <TextField id="token-name" label="Name" name="name" maxlength={100} autocomplete="off" required value={form?.tokenName ?? ""} />
    <SelectField id="token-expiry" name="expiry" label="Expires after">
        {#each data.tokenExpiry.choices as c (c.value)}
          <option value={c.value} selected={c.value === (form?.tokenExpiry ?? data.tokenExpiry.default)}>{c.label}</option>
        {/each}
    </SelectField>
    <Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Make a token</Button>
  </form>
</SettingsCard>
