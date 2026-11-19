<script lang="ts">
import type { Snippet } from "svelte";
let { title, description, actions, divider = false }: { title: string; description?: string; actions?: Snippet; divider?: boolean } = $props();
</script>

<div class="mb-6 flex flex-wrap items-start justify-between gap-4 {divider ? 'border-b border-[#eaeaec] pb-4' : ''}">
  <div>
    <h1 class="m-0 text-[24px] leading-8 font-semibold tracking-[-0.035em] text-[#171719]">{title}</h1>
    {#if description}<p class="mt-1 mb-0 text-sm leading-5 text-[#777980]">{description}</p>{/if}
  </div>
  {#if actions}<div class="flex shrink-0 items-center gap-2">{@render actions()}</div>{/if}
</div>
