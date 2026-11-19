<script lang="ts">
import { Folder } from "@lucide/svelte";
let { isAdmin, searching }: { isAdmin: boolean; searching: boolean } = $props();
</script>

<div class="flex min-h-[280px] flex-col items-center justify-center px-5 py-12 text-center">
  <div aria-hidden="true" class="mb-4 flex size-12 items-center justify-center rounded-xl border border-[#e9e9eb] bg-[#fafafa] text-[#8b8c92]">
    <Folder size={22} strokeWidth={1.5} aria-hidden="true" />
  </div>
  <p class="m-0 text-sm font-semibold text-[#303136]">{searching ? "No matching projects" : "No projects yet"}</p>
  <p class="mt-1.5 mb-0 max-w-72 text-sm leading-6 text-[#8a8b91]">{searching ? "Try a different search." : isAdmin ? "Create a project to get started." : "Projects you can access will appear here."}</p>
</div>
