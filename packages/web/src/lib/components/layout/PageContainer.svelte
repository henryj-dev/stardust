<script lang="ts">
import type { Snippet } from "svelte";
let { children }: { children: Snippet } = $props();
</script>

<main class="mx-auto w-full max-w-[1152px] px-5 pt-7 pb-16 sm:px-8">
  {@render children()}
</main>
