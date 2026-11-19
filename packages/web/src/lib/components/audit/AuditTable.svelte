<script lang="ts">
import type { AuditEventView } from "@stardust/sdk";
import { createTable, FlexRender } from "@tanstack/svelte-table";
import { CalendarDays, UserRound, Activity, Folder, Crosshair, AlignLeft, Globe } from "@lucide/svelte";
import { auditColumns, auditTableFeatures } from "./columns";
import AuditActionBadge from "./AuditActionBadge.svelte";

let {
  events,
  older,
  showProject,
  linkEvents = false,
}: { events: AuditEventView[]; older: string | null; showProject: boolean; linkEvents?: boolean } = $props();

const headerIcons = { at: CalendarDays, actor: UserRound, action: Activity, projectId: Folder, target: Crosshair, detail: AlignLeft, from: Globe };

const columns = $derived(auditColumns(showProject));

const table = createTable({
  features: auditTableFeatures,
  get data() { return events; },
  get columns() { return columns; },
  getRowId: (event) => event.id,
});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex: the overflow region needs keyboard focus for horizontal scrolling -->
<div role="region" aria-label="Audit events table" tabindex="0" class="w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066ff] rounded-[14px] border border-[#e7e7e7] bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)]">
  <table data-audit class="m-0 w-full min-w-[920px] border-collapse border-0 text-left text-sm">
    <caption class="sr-only">Audit events</caption>
    <thead>
      {#each table.getHeaderGroups() as group (group.id)}
        <tr>
          {#each group.headers as header (header.id)}
            <th scope="col" class="h-12 border-r border-b border-[#ededed] bg-white px-4 py-3 text-[13px] font-medium tracking-normal whitespace-nowrap text-[#929292] normal-case last:border-r-0">
              {#if !header.isPlaceholder}
                {@const Icon = headerIcons[header.column.id as keyof typeof headerIcons]}
                <span class="flex items-center gap-1.5">{#if Icon}<Icon size={15} strokeWidth={1.6} class="shrink-0 text-[#acacac]" aria-hidden="true" />{/if}<FlexRender {header} /></span>
              {/if}
            </th>
          {/each}
        </tr>
      {/each}
    </thead>
    <tbody>
      {#each table.getRowModel().rows as row (row.id)}
        <tr data-audit-event={row.original.action} class="group">
          {#each row.getAllCells() as cell (cell.id)}
            <td class="h-14 border-r border-b border-[#ededed] px-4 py-3 align-middle text-[#38383b] group-hover:bg-[#fafafa] last:border-r-0" title={cell.column.id === 'from' ? row.original.userAgent ?? undefined : undefined}>
              {#if cell.column.id === "at"}
                <time datetime={row.original.at} class="whitespace-nowrap tabular-nums">{new Date(row.original.at).toLocaleString()}</time>
              {:else if cell.column.id === "actor"}
                <FlexRender {cell} />{#if row.original.actor.kind === "token"}<br /><small>API token</small>{/if}
              {:else if cell.column.id === "action"}
                <AuditActionBadge action={row.original.action} href={linkEvents ? `/admin/audit/${encodeURIComponent(row.original.id)}` : undefined} />
              {:else if cell.column.id === "detail"}
                {#if cell.getValue()}<code class="break-all bg-transparent p-0 text-xs text-[#777980]"><FlexRender {cell} /></code>{:else}<span class="text-[#a1a1a7]" aria-label="No detail">—</span>{/if}
              {:else}
                {#if cell.getValue()}<span class="break-words"><FlexRender {cell} /></span>{:else}<span class="text-[#a1a1a7]" aria-label="No value">—</span>{/if}
              {/if}
            </td>
          {/each}
        </tr>
      {:else}
        <tr><td colspan={table.getAllLeafColumns().length} data-audit-empty class="h-32 px-4 text-center text-sm text-[#85868c]">No events.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
{#if older}
  <div class="mt-4 flex justify-end"><a href={older} data-audit-older class="inline-flex min-h-9 items-center rounded-lg border border-[#e4e4e7] px-3 text-[13px] font-medium text-[#44454a] hover:bg-[#f7f7f8] hover:no-underline">Older events</a></div>
{/if}
