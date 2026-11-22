<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";
import TextField from "$lib/components/ui/TextField.svelte";
import type { ActionData } from "../../../routes/(app)/account/$types";
import SettingsCard from "./SettingsCard.svelte";

let { form }: { form: ActionData | null } = $props();
</script>

<SettingsCard id="password" title="Password" description="Update your password to keep your account secure.">
  {#if form?.passwordError}
    <p role="alert" data-password-error>{form.passwordError}</p>
  {:else if form?.changed}
    <p data-password-changed>Changed. Your other sessions and your API tokens have ended.</p>
  {/if}
  <form method="POST" action="?/password#password" data-password>
    <TextField id="current-password" label="Current password" type="password" name="current" autocomplete="current-password" required />
    <TextField id="new-password" label="New password" type="password" name="password" autocomplete="new-password" minlength={12} required />
    <TextField id="confirm-password" label="Confirm new password" type="password" name="again" autocomplete="new-password" minlength={12} required />
    <Button type="submit" size="compact" fullWidth={false} class="justify-self-end">Change password</Button>
  </form>
</SettingsCard>
