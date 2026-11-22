<script lang="ts">
import { ChevronDown, LogOut, UserRound } from "@lucide/svelte";

let { user, onNavigate }: {
  user: { username: string; displayName: string | null; isAdmin: boolean };
  onNavigate: () => void;
} = $props();

const menuId = $props.id();
let left = $state(0);
let bottom = $state(0);
let width = $state(0);
let menu: HTMLElement;
let trigger: HTMLButtonElement;

function positionMenu() {
  const rect = trigger.getBoundingClientRect();
  left = rect.left;
  bottom = window.innerHeight - rect.top + 8;
  width = rect.width;
}

function closeMenu() {
  menu.hidePopover();
  onNavigate();
}
</script>

<svelte:window onresize={() => { if (menu?.matches(":popover-open")) positionMenu(); }} />

<div class="border-t border-[#e7e7e8] pt-3">
  <button bind:this={trigger} type="button" popovertarget={menuId} onclick={positionMenu} class="flex min-h-11 w-full items-center gap-3 rounded-lg border-0 bg-transparent px-2 text-left hover:bg-[#ededee] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0066ff]">
    <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#e6e7eb] text-xs font-semibold text-[#44464d]">{(user.displayName || user.username).slice(0, 1).toUpperCase()}</span>
    <span class="min-w-0 flex-1 truncate text-[13px] font-medium text-[#252525]">{user.displayName || user.username}</span>
    <ChevronDown size={16} strokeWidth={1.7} class="text-[#85868c]" aria-hidden="true" />
  </button>
  <div bind:this={menu} id={menuId} popover="auto" aria-label="Account menu" style={`inset: auto auto ${bottom}px ${left}px; width: ${width}px;`} class="m-0 max-w-[calc(100vw-24px)] rounded-xl border border-[#e6e6e8] bg-white p-1.5 text-[#252525] shadow-[0_8px_28px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.04)]">
    <div class="min-w-0 border-b border-[#ededee] px-2.5 py-2">
      <p class="m-0 truncate text-[13px] font-semibold">{user.displayName || user.username}</p>
      {#if user.displayName && user.displayName !== user.username}<p class="mt-0.5 mb-0 truncate text-xs text-[#85868c]">{user.username}</p>{/if}
    </div>
    <a href="/account" data-nav-account onclick={closeMenu} class="mt-1 flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium text-[#44454a] hover:bg-[#f4f4f5] hover:no-underline"><UserRound size={18} strokeWidth={1.6} aria-hidden="true" />Account settings</a>
    <form method="POST" action="/logout" class="m-0"><button type="submit" class="flex min-h-10 w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-left text-[13px] font-medium text-[#44454a] hover:bg-[#f4f4f5]"><LogOut size={18} strokeWidth={1.6} aria-hidden="true" />Sign out</button></form>
  </div>
</div>
