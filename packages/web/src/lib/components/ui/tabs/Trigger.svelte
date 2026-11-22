<script lang="ts">
import type { Snippet } from "svelte";
import { getTabsContext } from "./context";
let { value, disabled = false, children, class: className = "" }: {
  value: string;
  disabled?: boolean;
  children: Snippet;
  class?: string;
} = $props();
const tabs = getTabsContext();
const active = $derived(tabs.value === value);

function navigate(event: KeyboardEvent) {
  const forward = tabs.orientation === "vertical" ? "ArrowDown" : "ArrowRight";
  const backward = tabs.orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
  if (![forward, backward, "Home", "End"].includes(event.key)) return;
  const list = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  const triggers = Array.from(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? []);
  const current = triggers.indexOf(event.currentTarget as HTMLButtonElement);
  if (!triggers.length || current < 0) return;
  const index = event.key === "Home" ? 0 : event.key === "End" ? triggers.length - 1 : (current + (event.key === forward ? 1 : -1) + triggers.length) % triggers.length;
  event.preventDefault();
  triggers[index]?.focus();
}
</script>

<button type="button" role="tab" id={`${tabs.id}-tab-${value}`} aria-controls={`${tabs.id}-panel-${value}`} aria-selected={active} tabindex={active ? 0 : -1} {disabled} data-state={active ? "active" : "inactive"} data-orientation={tabs.orientation} onfocus={() => tabs.select(value)} onclick={() => tabs.select(value)} onkeydown={navigate} class={className}>
  {@render children()}
</button>
