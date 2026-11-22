<script lang="ts">
import PageContainer from "$lib/components/layout/PageContainer.svelte";
import { Search } from "@lucide/svelte";
import EmptyProjects from "$lib/components/projects/EmptyProjects.svelte";
import ProjectHeader from "$lib/components/projects/ProjectHeader.svelte";

let { data } = $props();
let search = $state("");
const filtered = $derived(data.projects.filter((project) => `${project.name} ${project.githubRepo ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())));
</script>

<svelte:head><title>Projects · stardust</title></svelte:head>

<PageContainer>
  <ProjectHeader isAdmin={!!data.user?.isAdmin} />

  {#if data.costs?.sources.length}
    <section data-costs class="mt-5 rounded-xl border border-[#ededee] p-4">
      <h2 class="m-0 border-0 p-0 text-sm font-semibold">This month</h2>
      <ul class="mt-2 mb-0 list-none p-0 text-sm text-[#66676d]">
        {#each data.costs.sources as c (c.name)}
          <li data-cost={c.name}>{c.name}: {#if c.total !== null}{c.total.toFixed(2)} {c.currency}{:else}unknown <small>({c.error})</small>{/if}</li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if data.projects.length > 0}
  <div class="mt-5 flex min-h-11 items-center gap-3 rounded-xl border border-[#e4e4e7] bg-white px-3.5 focus-within:border-[#a9abb2]">
    <Search size={18} strokeWidth={1.7} class="shrink-0 text-[#8c8d93]" aria-hidden="true" />
    <input aria-label="Search projects" type="search" bind:value={search} placeholder="Search projects..." class="h-10 w-full border-0 bg-transparent p-0 text-sm text-[#252529] placeholder:text-[#a0a1a6] focus:outline-none" />
  </div>
  <div class="mt-6 flex items-center justify-between border-b border-[#f0f0f1] pb-3 text-xs font-medium text-[#85868c]">
    <span>{filtered.length} {filtered.length === 1 ? "project" : "projects"}</span>
  </div>

  {/if}

  {#if filtered.length === 0}
    <EmptyProjects isAdmin={!!data.user?.isAdmin} searching={!!search.trim()} />
  {:else}
    <ul class="m-0 list-none p-0">
      {#each filtered as project (project.id)}
        <li data-project={project.id} class="flex flex-wrap items-center gap-4 border-b border-[#f0f0f1] py-4">
          <span aria-hidden="true" class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#f1f1f3] text-sm font-semibold text-[#55575e]">{project.name.slice(0, 1).toUpperCase()}</span>
          <div class="min-w-[140px] flex-1">
            <a href={`/projects/${encodeURIComponent(project.id)}`} class="block truncate text-sm font-semibold text-[#242529] hover:underline">{project.name}</a>
            <p class="mt-1 mb-0 truncate text-xs text-[#92939a]">{project.githubRepo ?? "No repository"}{project.region ? ` · ${project.region}${project.regionUnreachable ? " (not answering)" : ""}` : ""}</p>
          </div>
          {#if project.lastRun}
            <div class="min-w-[120px] text-xs text-[#85868c]"><a data-run-link href={`/projects/${encodeURIComponent(project.id)}/runs/${encodeURIComponent(project.lastRun.id)}`} class="text-[#55575e]">{new Date(project.lastRun.createdAt).toLocaleString()}</a><p class="mt-1 mb-0">{project.lastRun.ref} · {project.lastRun.sha.slice(0, 7)}{project.lastRun.requestedBy ? ` · pulled by ${project.lastRun.requestedBy}` : ""}</p></div>
            <span data-status={project.lastRun.status} class="rounded-full bg-[#f3f3f4] px-2.5 py-1 text-xs text-[#63646b]">{project.lastRun.status}</span>
          {:else}<span class="text-xs text-[#a0a1a6]">No runs yet</span>{/if}
          {#if data.user?.isAdmin}<a href={`/projects/${encodeURIComponent(project.id)}/settings`} data-edit-project class="rounded-lg px-2 py-2 text-xs text-[#777980] hover:bg-[#f3f3f4] hover:no-underline">Edit</a>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</PageContainer>
