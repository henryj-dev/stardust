<script lang="ts">
import type { AuditEventView } from "@stardust/sdk";

let { events, older, showProject }: { events: AuditEventView[]; older: string | null; showProject: boolean } = $props();

const who = (e: AuditEventView) =>
  e.actor.name ?? (e.actor.kind === "anonymous" ? "(someone signing in)" : e.actor.kind);
const from = (e: AuditEventView) => e.forwardedFor ?? e.ip ?? "";
</script>

{#if events.length === 0}
  <p data-audit-empty>No events.</p>
{:else}
  <table data-audit>
    <thead>
      <tr>
        <th>When</th><th>Who</th><th>Action</th>{#if showProject}<th>Project</th>{/if}<th>Target</th><th>Detail</th><th>From</th>
      </tr>
    </thead>
    <tbody>
      {#each events as e (e.id)}
        <tr data-audit-event={e.action}>
          <td><time datetime={e.at}>{new Date(e.at).toLocaleString()}</time></td>
          <td>
            {who(e)}{#if e.actor.kind === "token"}<br /><small>API token</small>{/if}
          </td>
          <td><code>{e.action}</code></td>
          {#if showProject}<td>{e.projectId ?? ""}</td>{/if}
          <td>{e.target ?? ""}</td>
          <!-- Text, never HTML. -->
          <td><code>{Object.keys(e.detail).length ? JSON.stringify(e.detail) : ""}</code></td>
          <td title={e.userAgent ?? ""}>{from(e)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
{#if older}
  <p><a href={older} data-audit-older>Older events</a></p>
{/if}
