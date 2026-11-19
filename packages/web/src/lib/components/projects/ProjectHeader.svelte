<script lang="ts">
import { Plus } from "@lucide/svelte";
let { isAdmin }: { isAdmin: boolean } = $props();
</script>

<div class="flex flex-wrap items-center justify-between gap-4 border-b border-[#eaeaec] pb-4">
  <div>
    <h1 class="m-0 text-[24px] leading-8 font-semibold tracking-[-0.035em] text-[#171719]">Projects</h1>
  </div>
  {#if isAdmin}
    <a href="/admin/projects/new" data-new-project class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#171719] px-4 text-[13px] font-semibold text-white hover:bg-[#343439] hover:text-white hover:no-underline"><Plus size={16} strokeWidth={1.8} aria-hidden="true" /> New project</a>
  {/if}
</div>
