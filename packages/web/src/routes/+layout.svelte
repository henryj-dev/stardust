<script lang="ts">
let { data, children } = $props();
</script>

{#if data.user}
  <header>
    <nav aria-label="Main">
      <a href="/">stardust</a>
      {#if data.user.isAdmin}
        <a href="/admin/users" data-nav-users>Users</a>
        {#if data.capabilities.includes("domains.list")}<a href="/domains" data-nav-domains>Domains</a>{/if}
        {#if data.capabilities.includes("nodes.list")}<a href="/nodes" data-nav-nodes>Nodes</a>{/if}
        {#if data.capabilities.includes("databases.list")}<a href="/databases" data-nav-databases>Databases</a>{/if}
        {#if data.capabilities.includes("instances.list")}<a href="/instances" data-nav-instances>Instances</a>{/if}
        {#if data.capabilities.includes("cloud-audit.findings")}<a href="/cloud-audit" data-nav-cloud-audit>Cloud audit</a>{/if}
        <a href="/admin/audit" data-nav-audit>Audit log</a>
      {/if}
      <a href="/account" data-nav-account>Account</a>
    </nav>
    <span data-user>{data.user.displayName || data.user.username}</span>
    <!-- Signing out changes state, so it is a POST, never a link. -->
    <form method="POST" action="/logout"><button type="submit">Sign out</button></form>
  </header>
{/if}

{@render children()}
