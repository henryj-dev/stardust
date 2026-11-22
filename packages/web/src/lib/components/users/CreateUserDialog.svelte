<script lang="ts">
import { onMount } from "svelte";
import { Plus, X } from "@lucide/svelte";
import Button from "$lib/components/ui/Button.svelte";
import TextField from "$lib/components/ui/TextField.svelte";
let { error = null }: { error?: string | null } = $props();
let dialog: HTMLDialogElement;
onMount(() => { if (error) dialog.showModal(); });
</script>

<Button size="compact" fullWidth={false} onclick={() => dialog.showModal()}><Plus size={16} aria-hidden="true" /> <span class="ml-2">Add user</span></Button>
<dialog bind:this={dialog} aria-labelledby="create-user-title" class="m-auto w-[calc(100%-2rem)] max-w-[460px] rounded-2xl border border-[#e7e7e9] bg-white p-0 text-[#171719] shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop:bg-black/35">
  <div class="flex items-start justify-between gap-4 p-6 pb-0">
    <div><h2 id="create-user-title" class="m-0 border-0 p-0 text-lg font-semibold">Add a user</h2><p class="mt-1 mb-0 text-sm leading-5 text-[#777980]">Create an account and generate an invitation link.</p></div>
    <button type="button" aria-label="Close dialog" onclick={() => dialog.close()} class="flex size-10 shrink-0 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#777980] hover:bg-[#f3f3f4]"><X size={18} aria-hidden="true" /></button>
  </div>
  <form method="POST" action="?/create" data-create-user class="m-0 grid gap-4 p-6">
    {#if error}<p role="alert" class="m-0 rounded-lg bg-[#fff1f1] px-3 py-2 text-sm text-[#b4232e]">{error}</p>{/if}
    <TextField id="new-user-username" label="Username" name="username" pattern={"[a-z0-9][a-z0-9._-]{0,62}"} autocomplete="off" required />
    <TextField id="new-user-display-name" label="Display name" name="displayName" />
    <label class="flex items-center gap-2 text-sm text-[#44454a]"><input type="checkbox" name="isAdmin" /> Administrator</label>
    <div class="flex justify-end gap-2 pt-2"><Button size="compact" variant="secondary" fullWidth={false} onclick={() => dialog.close()}>Cancel</Button><Button type="submit" size="compact" fullWidth={false}>Add and invite</Button></div>
  </form>
</dialog>
