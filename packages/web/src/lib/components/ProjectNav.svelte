<script lang="ts">
// A project's pages as tabs, under its name. `current` is the page shown.
let {
  projectId,
  current,
  isAdmin = false,
}: { projectId: string; current: "runs" | "env" | "audit" | "settings"; isAdmin?: boolean } = $props();
const base = $derived(`/projects/${encodeURIComponent(projectId)}`);
const tabs = $derived([
  { id: "runs", href: base, label: "Runs", hook: "data-runs-link" },
  { id: "env", href: `${base}/env`, label: "Environment", hook: "data-env-link" },
  { id: "audit", href: `${base}/audit`, label: "Audit log", hook: "data-audit-link" },
  ...(isAdmin ? [{ id: "settings", href: `${base}/settings`, label: "Settings", hook: "data-settings" }] : []),
]);
</script>

<nav class="tabs" aria-label="Project">
  {#each tabs as t (t.id)}
    <a href={t.href} aria-current={t.id === current ? "page" : undefined} {...{ [t.hook]: "" }}>{t.label}</a>
  {/each}
</nav>
