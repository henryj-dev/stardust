<script lang="ts">
let { data, children } = $props();
</script>

{#if data.user}
  <header>
    <nav aria-label="Main">
      <a href="/">stardust</a>
      {#if data.user.isAdmin}<a href="/admin/audit" data-nav-audit>Audit log</a>{/if}
    </nav>
    <span data-user>{data.user.displayName || data.user.username}</span>
    <!-- Signing out changes state, so it is a POST, never a link. -->
    <form method="POST" action="/logout"><button type="submit">Sign out</button></form>
  </header>
{/if}

{@render children()}
