<script lang="ts">
import Button from "$lib/components/ui/Button.svelte";
import type { PageData } from "../../../routes/(app)/admin/users/$types";

let { settings, saved = false }: { settings: NonNullable<PageData["signIn"]>; saved?: boolean } = $props();
const ac = $derived(settings.oidc?.autoCreate);
const choices = $derived([
  {
    value: "on",
    label: "Create one",
    hint: "A member; they see projects once added to them.",
    checked: ac?.set === true,
  },
  { value: "off", label: "Turn them away", hint: "They wait below to be let in.", checked: ac?.set === false },
  {
    value: "config",
    label: "As the configuration says",
    hint: ac?.configured ? "It says: create one." : "It says: turn them away.",
    checked: ac?.set === null,
  },
]);
</script>

{#if ac}
  <section aria-labelledby="sign-in-settings-title" class="mb-8 rounded-2xl border border-[#ededee] p-5">
    <h2 id="sign-in-settings-title" class="m-0 border-0 p-0 text-base font-semibold text-[#252529]">Single sign-on</h2>
    <p class="mt-1 mb-4 text-sm text-[#777980]">When someone the provider signs in has no account here.</p>
    <form method="POST" action="?/signInSettings" data-sign-in-settings class="m-0 grid gap-3">
      <fieldset class="m-0 grid gap-2 border-0 p-0">
        <legend class="sr-only">When someone has no account</legend>
        {#each choices as c (c.value)}
          <label class="flex cursor-pointer items-start gap-3 rounded-xl border border-[#ededee] px-4 py-3 has-[:checked]:border-[#0066ff] has-[:checked]:bg-[#f5f9ff]">
            <input type="radio" name="autoCreate" value={c.value} checked={c.checked} class="mt-1" />
            <span><span class="block text-sm font-semibold text-[#292a2f]">{c.label}</span><span class="block text-xs text-[#777980]">{c.hint}</span></span>
          </label>
        {/each}
      </fieldset>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p data-auto-create={ac.effective ? "on" : "off"} class="m-0 text-xs text-[#777980]">
          Now: {ac.effective ? "an account is created" : "they are turned away"}{settings.updatedBy ? ` · last changed by ${settings.updatedBy}` : ""}.
          {#if saved}<span data-sign-in-saved class="text-[#287345]">Saved: it applies to the next sign-in.</span>{/if}
        </p>
        <Button type="submit" size="compact" fullWidth={false}>Save</Button>
      </div>
    </form>
  </section>
{/if}
