<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";
import type { ActionData, PageData } from "../../../routes/(app)/account/$types";
import SettingsCard from "./SettingsCard.svelte";

let { data, form }: { data: PageData; form: ActionData | null } = $props();
const time = (iso: string) => new Date(iso).toLocaleString();
</script>

<SettingsCard id="sessions" title="Sessions" description="Review and manage active sign-in sessions.">
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
              <form method="POST" action="?/end#sessions">
                <input type="hidden" name="session" value={s.id} />
                <Button type="submit" size="compact" fullWidth={false} variant="danger" class="justify-self-end">End</Button>
              </form>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</SettingsCard>
