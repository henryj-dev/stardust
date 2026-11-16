<script lang="ts">
let { data } = $props();
const e = $derived(data.event);
</script>

<svelte:head>
  <title>Audit event {e.id} · stardust</title>
</svelte:head>

<main>
  <p><a href="/admin/audit">← Audit log</a></p>
  <h1><code>{e.action}</code></h1>
  <dl data-audit-event={e.id}>
    <dt>When</dt>
    <dd>{new Date(e.at).toLocaleString()}</dd>
    <dt>Who</dt>
    <dd>{e.actor.name ?? "—"} ({e.actor.kind}{e.actor.tokenId ? `, token ${e.actor.tokenId}` : ""})</dd>
    <dt>Project</dt>
    <dd>{e.projectId ?? "—"}</dd>
    <dt>Target</dt>
    <dd>{e.target ?? "—"}</dd>
    <dt>From</dt>
    <dd>{e.ip ?? "—"}{e.forwardedFor ? ` (for ${e.forwardedFor})` : ""}</dd>
    <dt>Client</dt>
    <dd>{e.userAgent ?? "—"}</dd>
  </dl>
  <h2>Detail</h2>
  <!-- Names, never values: the server refuses to record a credential. -->
  <pre>{JSON.stringify(e.detail, null, 2)}</pre>
</main>

<style>
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.25rem 1rem;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
