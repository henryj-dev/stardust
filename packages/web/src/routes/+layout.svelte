<script lang="ts">
import "../app.css";
import { page } from "$app/state";

let { data, children } = $props();
// The section the page is in: a nav link marks itself current for it and the pages under it.
const current = (href: string) =>
  page.url.pathname === href || (href !== "/" && page.url.pathname.startsWith(`${href}/`)) ? "page" : undefined;
</script>

{#if data.user}
  <header>
    <nav aria-label="Main">
      <a href="/">stardust</a>
      {#if data.user.isAdmin}
        <a href="/admin/users" aria-current={current("/admin/users")} data-nav-users>Users</a>
        {#if data.capabilities.includes("domains.list")}<a href="/domains" aria-current={current("/domains")} data-nav-domains>Domains</a>{/if}
        {#if data.capabilities.includes("nodes.list")}<a href="/nodes" aria-current={current("/nodes")} data-nav-nodes>Nodes</a>{/if}
        {#if data.capabilities.includes("databases.list")}<a href="/databases" aria-current={current("/databases")} data-nav-databases>Databases</a>{/if}
        {#if data.capabilities.includes("instances.list")}<a href="/instances" aria-current={current("/instances")} data-nav-instances>Instances</a>{/if}
        {#if data.capabilities.includes("cloud-audit.findings")}<a href="/cloud-audit" aria-current={current("/cloud-audit")} data-nav-cloud-audit>Cloud audit</a>{/if}
        {#if data.capabilities.includes("upstream-images.checks")}<a href="/upstream-images" aria-current={current("/upstream-images")} data-nav-upstream-images>Upstream images</a>{/if}
        <a href="/admin/audit" aria-current={current("/admin/audit")} data-nav-audit>Audit log</a>
      {/if}
      <a href="/account" aria-current={current("/account")} data-nav-account>Account</a>
    </nav>
    <span data-user>{data.user.displayName || data.user.username}</span>
    <!-- Signing out changes state, so it is a POST, never a link. -->
    <form method="POST" action="/logout"><button type="submit">Sign out</button></form>
  </header>
{/if}

{@render children()}
