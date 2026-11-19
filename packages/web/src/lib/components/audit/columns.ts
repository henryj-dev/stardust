import type { AuditEventView } from "@stardust/sdk";
import { createColumnHelper, tableFeatures } from "@tanstack/svelte-table";

export const auditTableFeatures = tableFeatures({});
const column = createColumnHelper<typeof auditTableFeatures, AuditEventView>();

export function auditColumns(showProject: boolean) {
  return column.columns([
    column.accessor("at", { header: "When" }),
    column.accessor((event) => event.actor.name ?? (event.actor.kind === "anonymous" ? "(someone signing in)" : event.actor.kind), { id: "actor", header: "Who" }),
    column.accessor("action", { header: "Action" }),
    ...(showProject ? [column.accessor("projectId", { header: "Project" })] : []),
    column.accessor("target", { header: "Target" }),
    column.accessor((event) => Object.keys(event.detail).length ? JSON.stringify(event.detail) : "", { id: "detail", header: "Detail" }),
    column.accessor((event) => event.forwardedFor ?? event.ip ?? "", { id: "from", header: "From" }),
  ]);
}
