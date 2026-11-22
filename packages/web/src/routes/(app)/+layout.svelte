<script lang="ts">
import AppShell from "$lib/components/layout/AppShell.svelte";

let { data, children } = $props();
</script>

{#if data.user}
  <AppShell user={data.user} capabilities={data.capabilities}>
    {@render children()}
  </AppShell>
{:else}
  {@render children()}
{/if}
