<script lang="ts">
import type { Snippet } from "svelte";
import Sidebar from "./Sidebar.svelte";
import TopBar from "./TopBar.svelte";

let {
  user,
  capabilities,
  children,
}: {
  user: { username: string; displayName: string | null; isAdmin: boolean };
  capabilities: string[];
  children: Snippet;
} = $props();
let menuOpen = $state(false);

function onKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape" || !menuOpen || document.querySelector(":popover-open")) return;
  menuOpen = false;
  document.getElementById("app-menu-toggle")?.focus();
}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="min-h-screen bg-white [color-scheme:light] text-[#171719] antialiased md:flex">
  {#if menuOpen}
    <button type="button" aria-label="Close navigation" onclick={() => menuOpen = false} class="fixed inset-0 z-30 h-full w-full border-0 bg-black/25 p-0 md:hidden"></button>
  {/if}
  <div id="app-sidebar" class="fixed inset-y-0 left-0 z-40 w-60 border-r border-[#ededee] md:sticky md:top-0 md:h-screen md:shrink-0 {menuOpen ? 'block' : 'hidden md:block'}">
    <Sidebar {user} {capabilities} onNavigate={() => menuOpen = false} />
  </div>
  <div class="min-w-0 flex-1">
    <TopBar {menuOpen} toggleMenu={() => menuOpen = !menuOpen} />
    {@render children()}
  </div>
</div>
