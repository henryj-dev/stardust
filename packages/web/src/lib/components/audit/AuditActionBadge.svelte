<script lang="ts">
let { action, href }: { action: string; href?: string } = $props();

const color = $derived(
  action.startsWith("auth.") ? "bg-[#f7f1ff] text-[#7931ba]" :
  action.startsWith("project.") ? "bg-[#eff7ff] text-[#2066a6]" :
  "bg-[#f5f5f5] text-[#55565b]",
);
const classes = $derived(`inline-flex max-w-full break-all rounded-md px-2 py-1 text-xs leading-4 font-medium ${color}`);
</script>

{#if href}
  <a {href} class="{classes} hover:brightness-95 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066ff]">{action}</a>
{:else}
  <span class={classes}>{action}</span>
{/if}
