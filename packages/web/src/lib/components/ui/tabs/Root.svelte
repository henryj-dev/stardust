<script lang="ts">
import type { Snippet } from "svelte";
import { type Orientation, setTabsContext } from "./context";

let {
  value = $bindable(),
  orientation = "horizontal",
  onValueChange,
  children,
  class: className = "",
}: {
  value: string;
  orientation?: Orientation;
  onValueChange?: (value: string) => void;
  children: Snippet;
  class?: string;
} = $props();
const id = $props.id();
setTabsContext({
  id,
  get value() {
    return value;
  },
  get orientation() {
    return orientation;
  },
  select(next) {
    if (next !== value) {
      value = next;
      onValueChange?.(next);
    }
  },
});
</script>

<div class={className} data-orientation={orientation}>{@render children()}</div>
