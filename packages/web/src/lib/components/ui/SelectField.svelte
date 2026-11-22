<script lang="ts">
import type { Snippet } from "svelte";

let {
  id,
  name,
  label,
  disabled = false,
  children,
}: { id: string; name: string; label: string; disabled?: boolean; children: Snippet } = $props();
</script>

<div class="grid gap-1.5">
  <label for={id} class="text-sm font-semibold text-[#292a2f]">{label}</label>
  <select {id} {name} {disabled} class="min-h-12 w-full rounded-[10px] border border-[#dedfe2] bg-white px-4 py-2.5 text-base text-[#171719] focus:border-[#0066ff] focus:outline-none disabled:cursor-not-allowed disabled:bg-[#f1f2f4] forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-offset-2">
    {@render children()}
  </select>
</div>
