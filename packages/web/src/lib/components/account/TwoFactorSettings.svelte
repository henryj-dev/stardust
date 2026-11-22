<script lang="ts">
import SettingsCard from "./SettingsCard.svelte";
import Button from "$lib/components/ui/Button.svelte";
import TextField from "$lib/components/ui/TextField.svelte";
import type { PageData, ActionData } from "../../../routes/(app)/account/$types";
let { data, form }: { data: PageData; form: ActionData | null } = $props();
</script>

<SettingsCard id="two-factor" title="Two-step sign-in" description="Add an extra layer of security with an authenticator app.">
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
    <form method="POST" action="?/totpConfirm#two-factor">
      <TextField id="totp-confirm-code" label="Code" name="code" inputmode="numeric" autocomplete="one-time-code" required />
      <Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Turn on</Button>
    </form>
  {:else if data.totp.enrolled && !form?.totpOff}
    <p data-totp-on>On. {data.totp.recoveryCodesLeft} recovery code(s) left.</p>
    <form method="POST" action="?/totpCodes#two-factor">
      <TextField id="totp-recovery-code" label="Code from your app" name="code" inputmode="numeric" autocomplete="one-time-code" required />
      <Button type="submit" size="compact" fullWidth={false} variant="secondary" class="justify-self-end">New recovery codes</Button>
    </form>
    {#if data.totp.policy !== "required"}
      <form method="POST" action="?/totpOff#two-factor">
        <TextField id="totp-off-code" label="Code (or a recovery code)" name="code" autocomplete="one-time-code" required />
        <Button type="submit" size="compact" fullWidth={false} variant="danger" class="justify-self-end">Turn off</Button>
      </form>
    {/if}
  {:else}
    <p data-totp-off>{data.totp.policy === "required" ? "Required on this server: set it up to continue." : "Off."}</p>
    <form method="POST" action="?/totpSetup#two-factor"><Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Set up</Button></form>
  {/if}
</SettingsCard>
