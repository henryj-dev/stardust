<script lang="ts">
import { Database, FileText, Globe, LayoutGrid, Monitor, Server, ShieldCheck, Users } from "@lucide/svelte";
import { page } from "$app/state";
import AccountMenu from "./AccountMenu.svelte";

let {
  user,
  capabilities,
  onNavigate,
}: {
  user: { username: string; displayName: string | null; isAdmin: boolean };
  capabilities: string[];
  onNavigate: () => void;
} = $props();

const items = $derived([
  { label: "Projects", href: "/", icon: LayoutGrid, hook: "", show: true },
  { label: "Users", href: "/admin/users", icon: Users, hook: "users", show: user.isAdmin },
  {
    label: "Domains",
    href: "/domains",
    icon: Globe,
    hook: "domains",
    show: user.isAdmin && capabilities.includes("domains.list"),
  },
  {
    label: "Nodes",
    href: "/nodes",
    icon: Server,
    hook: "nodes",
    show: user.isAdmin && capabilities.includes("nodes.list"),
  },
  {
    label: "Databases",
    href: "/databases",
    icon: Database,
    hook: "databases",
    show: user.isAdmin && capabilities.includes("databases.list"),
  },
  {
    label: "Instances",
    href: "/instances",
    icon: Monitor,
    hook: "instances",
    show: user.isAdmin && capabilities.includes("instances.list"),
  },
  {
    label: "Cloud audit",
    href: "/cloud-audit",
    icon: FileText,
    hook: "cloud-audit",
    show: user.isAdmin && capabilities.includes("cloud-audit.findings"),
  },
  {
    label: "Upstream images",
    href: "/upstream-images",
    icon: ShieldCheck,
    hook: "upstream-images",
    show: user.isAdmin && capabilities.includes("upstream-images.checks"),
  },
  { label: "Audit log", href: "/admin/audit", icon: FileText, hook: "audit", show: user.isAdmin },
]);
const isCurrent = (href: string) =>
  href === "/"
    ? page.url.pathname === "/" || page.url.pathname.startsWith("/projects/")
    : page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
</script>

<aside class="flex h-full min-h-0 flex-col bg-[#f8f8f8] px-3 py-4 text-[#252525]">
  <a href="/" onclick={onNavigate} class="mb-7 flex h-9 items-center gap-2.5 px-2 text-[17px] font-bold tracking-[-0.04em] text-[#171719] hover:no-underline">
    <span aria-hidden="true" class="flex size-6 items-center justify-center rounded-md bg-[#171719] text-sm text-white">✳</span>stardust
  </a>
  <nav aria-label="Main navigation" class="min-h-0 flex-1 overflow-y-auto">
    <p class="mb-2 px-2 text-[11px] font-semibold tracking-[0.05em] text-[#8d8e93] uppercase">Workspace</p>
    <ul class="m-0 grid list-none gap-1 p-0">
      {#each items.filter((item) => item.show) as item (item.href)}
        <li><a href={item.href} {...(item.hook ? { [`data-nav-${item.hook}`]: "" } : {})} onclick={onNavigate} aria-current={isCurrent(item.href) ? "page" : undefined} class="flex min-h-10 items-center gap-3 rounded-lg px-2.5 text-[13px] font-medium hover:bg-[#ededee] hover:no-underline {isCurrent(item.href) ? 'bg-[#e9e9ea] text-[#171719]' : 'text-[#66676d]'}"><item.icon size={18} strokeWidth={1.6} aria-hidden="true" />{item.label}</a></li>
      {/each}
    </ul>
  </nav>
  <AccountMenu {user} {onNavigate} />
</aside>
