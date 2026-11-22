<script lang="ts">
import type { Snippet } from "svelte";
let { id, title, description, children }: { id: string; title: string; description: string; children: Snippet } = $props();
</script>

<section {id} class="settings-card m-0 scroll-mt-6 rounded-none border-0 bg-transparent px-0 py-2 md:px-0">
  <div class="mb-5">
    <h2 class="m-0 border-0 p-0 text-base leading-6 font-semibold tracking-[-0.02em] text-[#202124]">{title}</h2>
    <p class="mt-1 mb-0 text-sm leading-5 text-[#73757b]">{description}</p>
  </div>
  {@render children()}
</section>

<style>
  .settings-card :global(form) { display: grid; gap: 14px; margin: 0 0 16px; max-width: 440px; }
  .settings-card :global(form:last-child) { margin-bottom: 0; }
  .settings-card :global(p) { font-size: 14px; line-height: 1.5; }
  .settings-card :global([role="alert"]) { border-radius: 8px; background: #fff1f1; padding: 10px 12px; color: #b4232e; }
  .settings-card :global(pre), .settings-card :global(code) { overflow-wrap: anywhere; white-space: pre-wrap; }
  .settings-card :global(table) { font-size: 13px; }
  .settings-card :global(th) { background: #fafafa; color: #777980; font-weight: 500; letter-spacing: 0; text-transform: none; }
  .settings-card :global(td) { vertical-align: middle; }
  .settings-card :global(td form) { margin: 0; }
</style>
