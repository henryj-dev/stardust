<script lang="ts">
import type { PageData } from "../../../routes/(app)/admin/users/$types";
import UserActions from "./UserActions.svelte";

let { users, me, sso = false }: { users: PageData["users"]; me: string; sso?: boolean } = $props();
</script>

<div class="@container border-t border-[#ededee]">
  <div aria-hidden="true" class="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_40px] gap-4 border-b border-[#ededee] px-2 py-3 text-xs font-medium text-[#8a8b91] @lg:grid"><span>User</span><span>Signs in with</span><span>Role</span><span>Projects</span><span></span></div>
  <ul aria-label="Users" class="m-0 list-none p-0">
    {#each users as user (user.id)}
      <li data-user={user.username} data-disabled={user.disabled} class="m-0 grid grid-cols-[minmax(0,1fr)_40px] items-center gap-4 border-b border-[#f0f0f1] px-2 py-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_40px]">
        <div class="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#f0f1f3] text-sm font-semibold text-[#55575e]">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span>
          <div class="min-w-0"><p class="m-0 truncate text-sm font-semibold text-[#252529]">{user.displayName || user.username}</p>{#if (user.displayName && user.displayName !== user.username) || user.disabled || user.username === me}<p class="mt-0.5 mb-0 truncate text-xs text-[#85868c]">{user.displayName && user.displayName !== user.username ? user.username : user.username === me ? "You" : ""}{user.disabled ? " · Disabled" : ""}</p>{/if}</div>
        </div>
        <div class="col-start-1 min-w-0 text-xs text-[#777980] @lg:col-auto @lg:text-sm">{user.oidc ? 'Single sign-on' : user.hasPassword ? 'Password' : 'Invited'}{#if user.oidc}<span class="block truncate text-xs text-[#9a9ba1]" title={user.oidc.subject}>{user.oidc.subject}</span>{/if}</div>
        <div class="col-start-1 text-xs text-[#777980] @lg:col-auto @lg:text-sm">{user.isAdmin ? 'Administrator' : 'Member'}</div>
        <div class="col-start-1 min-w-0 text-xs leading-5 break-words text-[#777980] @lg:col-auto">{user.roles.map((role) => `${role.projectId} (${role.role})`).join(', ') || '—'}</div>
        <div class="col-start-2 row-start-1 @lg:col-auto @lg:row-auto"><UserActions {user} {me} {sso} /></div>
      </li>
    {:else}
      <li class="py-12 text-center text-sm text-[#85868c]">No users yet.</li>
    {/each}
  </ul>
</div>
