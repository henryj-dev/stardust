<script lang="ts">
import { Menu } from "@lucide/svelte";
import { page } from "$app/state";

let { menuOpen, toggleMenu }: { menuOpen: boolean; toggleMenu: () => void } = $props();
const title = $derived.by(() => {
  const path = page.url.pathname;
  if (path.startsWith("/admin/users")) return "Users";
  if (path.startsWith("/admin/audit")) return "Audit log";
  if (path.startsWith("/admin/projects") || path.startsWith("/projects") || path === "/") return "Projects";
  const names: Record<string, string> = {
    domains: "Domains",
    nodes: "Nodes",
    databases: "Databases",
    instances: "Instances",
    "cloud-audit": "Cloud audit",
    "upstream-images": "Upstream images",
    account: "Account",
  };
  return names[path.split("/")[1] ?? ""] ?? "Workspace";
});
</script>

<header class="flex h-14 shrink-0 items-center gap-3 border-b border-[#ededee] bg-white px-5 sm:px-7">
  <button id="app-menu-toggle" type="button" aria-label={menuOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={menuOpen} aria-controls="app-sidebar" onclick={toggleMenu} class="flex size-10 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#686a70] hover:bg-[#f2f2f3] md:hidden">
    <Menu size={19} strokeWidth={1.6} aria-hidden="true" />
  </button>
  <span class="text-[13px] font-medium text-[#85868c]">Workspace</span>
  <span aria-hidden="true" class="text-[#c1c2c6]">/</span>
  <span class="text-[13px] font-medium text-[#242529]">{title}</span>
</header>
