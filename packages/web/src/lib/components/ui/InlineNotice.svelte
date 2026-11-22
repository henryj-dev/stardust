<script lang="ts">
import type { Snippet } from "svelte";

let { children }: { children: Snippet } = $props();
</script>

<p role="alert" class="m-0 rounded-xl bg-[#fff1f1] px-4 py-3 text-sm leading-5 text-[#c62e36]">
  {@render children()}
</p>
