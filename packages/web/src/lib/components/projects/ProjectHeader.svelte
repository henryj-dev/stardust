<script lang="ts">
import { Plus } from "@lucide/svelte";
import PageHeader from "$lib/components/layout/PageHeader.svelte";

let { isAdmin }: { isAdmin: boolean } = $props();
</script>

<PageHeader title="Projects" divider>
  {#snippet actions()}
    {#if isAdmin}
      <a href="/admin/projects/new" data-new-project class="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#171719] px-4 text-[13px] font-semibold text-white hover:bg-[#343439] hover:text-white hover:no-underline"><Plus size={16} strokeWidth={1.8} aria-hidden="true" /> New project</a>
    {/if}
  {/snippet}
</PageHeader>
