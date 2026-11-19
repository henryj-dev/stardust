<script lang="ts">
import type { Snippet } from "svelte";

let { children, variant = "primary", type = "button" }: {
  children: Snippet;
  variant?: "primary" | "secondary";
  type?: "button" | "submit";
} = $props();
</script>

<button
  {type}
  class="control flex h-12 w-full items-center justify-center rounded-xl border text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066ff] {variant === 'primary' ? 'primary border-[#0066ff] bg-[#0066ff] text-white' : 'secondary border-[#dedfe2] bg-white text-[#171719]'}"
>
  {@render children()}
</button>

<style>
  @media (hover: hover) and (pointer: fine) {
    .primary:hover { background-color: #0055d9; }
    .secondary:hover { background-color: #f7f8fa; }
  }

  @media (prefers-reduced-motion: no-preference) {
    .control { transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
    .control:active:not(:focus-visible) { transform: scale(0.97); }
  }
</style>
