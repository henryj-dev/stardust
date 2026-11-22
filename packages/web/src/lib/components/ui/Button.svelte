<script lang="ts">
import type { Snippet } from "svelte";

let { children, variant = "primary", type = "button", size = "regular", fullWidth = true, disabled = false, onclick, class: className = "" }: {
  children: Snippet;
  variant?: "primary" | "secondary" | "danger";
  type?: "button" | "submit";
  size?: "regular" | "compact";
  fullWidth?: boolean;
  disabled?: boolean;
  onclick?: (event: MouseEvent) => void;
  class?: string;
} = $props();
</script>

<button
  {type} {disabled} {onclick}
  class="control {variant} inline-flex items-center justify-center border text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066ff] disabled:cursor-not-allowed disabled:opacity-50 {size === 'compact' ? 'min-h-10 rounded-lg px-4' : 'h-12 rounded-xl px-4'} {fullWidth ? 'w-full' : 'w-auto'} {variant === 'primary' ? 'border-[#0066ff] bg-[#0066ff] text-white' : variant === 'danger' ? 'border-[#efc9c9] bg-white text-[#b4232e]' : 'border-[#dedfe2] bg-white text-[#171719]'} {className}"
>
  {@render children()}
</button>

<style>
  @media (hover: hover) and (pointer: fine) {
    .primary:hover:not(:disabled) { background-color: #0055d9; }
    .secondary:hover:not(:disabled) { background-color: #f7f8fa; }
    .danger:hover:not(:disabled) { background-color: #fff1f1; }
  }

  @media (prefers-reduced-motion: no-preference) {
    .control { transition: transform 160ms cubic-bezier(0.23, 1, 0.32, 1); }
    .control:active:not(:focus-visible):not(:disabled) { transform: scale(0.97); }
  }
</style>
