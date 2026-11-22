<script lang="ts">
import type { Snippet } from "svelte";
import { getTabsContext } from "./context";
let { value, children, class: className = "" }: { value: string; children: Snippet; class?: string } = $props();
const tabs = getTabsContext();
</script>

<div role="tabpanel" id={`${tabs.id}-panel-${value}`} aria-labelledby={`${tabs.id}-tab-${value}`} hidden={tabs.value !== value} tabindex="0" data-state={tabs.value === value ? "active" : "inactive"} class={className}>
  {@render children()}
</div>
