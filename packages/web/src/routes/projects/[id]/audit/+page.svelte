<script lang="ts">
import AuditTable from "$lib/components/AuditTable.svelte";

let { data } = $props();
</script>

<svelte:head>
  <title>Audit · {data.projectId} · stardust</title>
</svelte:head>

<main>
  <p><a href={`/projects/${encodeURIComponent(data.projectId)}`}>{data.projectId}</a></p>
  <h1>Audit log</h1>
  <form method="GET" data-audit-filter>
    <label>Who <input name="actor" value={data.filter.actor ?? ""} placeholder="username" /></label>
    <label>Action <input name="action" value={data.filter.action ?? ""} placeholder="run, project…" /></label>
    <label>From (UTC) <input type="datetime-local" name="since" value={data.filter.since?.replace(/Z$/, "") ?? ""} /></label>
    <label>Until (UTC) <input type="datetime-local" name="until" value={data.filter.until?.replace(/Z$/, "") ?? ""} /></label>
    <button type="submit">Show</button>
  </form>
  {#if data.problem}
    <p role="alert" data-audit-problem>{data.problem}</p>
  {/if}
  <AuditTable events={data.events} older={data.older} showProject={false} />
</main>
