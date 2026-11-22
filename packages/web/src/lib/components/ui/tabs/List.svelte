<script lang="ts">
import type { Snippet } from "svelte";
import { getTabsContext } from "./context";

let { label, children, class: className = "" }: { label: string; children: Snippet; class?: string } = $props();
const tabs = getTabsContext();
</script>

<div role="tablist" aria-label={label} aria-orientation={tabs.orientation} data-orientation={tabs.orientation} class={className}>
  {@render children()}
</div>
