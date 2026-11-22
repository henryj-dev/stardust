<script lang="ts">
import { MoreHorizontal } from "@lucide/svelte";
import type { PageData } from "../../../routes/(app)/admin/users/$types";

let { user, me, sso = false }: { user: PageData["users"][number]; me: string; sso?: boolean } = $props();
const menuId = $props.id();
let trigger: HTMLButtonElement;
let left = $state(0);
let top = $state(0);
function position() {
  const rect = trigger.getBoundingClientRect();
  left = Math.max(8, rect.right - 208);
  top = Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - 232));
}
</script>

<button bind:this={trigger} type="button" popovertarget={menuId} onclick={position} aria-label={`Actions for ${user.username}`} class="flex size-10 items-center justify-center rounded-lg border-0 bg-transparent p-0 text-[#777980] hover:bg-[#f2f2f3] focus-visible:outline-2 focus-visible:outline-[#0066ff]"><MoreHorizontal size={19} aria-hidden="true" /></button>
<div id={menuId} popover="auto" aria-label={`Actions for ${user.username}`} style={`inset: ${top}px auto auto ${left}px;`} class="user-actions m-0 w-52 rounded-xl border border-[#e7e7e9] bg-white p-1.5 shadow-[0_8px_24px_rgba(0,0,0,0.1)]">
  {#if !user.oidc}<form method="POST" action="?/link"><input type="hidden" name="username" value={user.username} /><input type="hidden" name="purpose" value={user.hasPassword ? 'reset' : 'invite'} /><button type="submit">{user.hasPassword ? 'Reset link' : 'Invite link'}</button></form>{/if}
  {#if user.username !== me}
    <form method="POST" action="?/update"><input type="hidden" name="username" value={user.username} /><input type="hidden" name="isAdmin" value={user.isAdmin ? 'false' : 'true'} /><button type="submit">{user.isAdmin ? 'Make member' : 'Make administrator'}</button></form>
    <form method="POST" action="?/update"><input type="hidden" name="username" value={user.username} /><input type="hidden" name="disabled" value={user.disabled ? 'false' : 'true'} /><button type="submit">{user.disabled ? 'Enable' : 'Disable'}</button></form>
  {/if}
  {#if user.oidc}
    <form method="POST" action="?/sso"><input type="hidden" name="username" value={user.username} /><input type="hidden" name="op" value="unlink" /><button type="submit">Unlink single sign-on</button></form>
  {:else if sso}
    <form method="POST" action="?/sso" class="link-sso"><input type="hidden" name="username" value={user.username} /><input name="subject" placeholder="Single sign-on subject" aria-label={`Single sign-on subject for ${user.username}`} required autocomplete="off" /><button type="submit">Link single sign-on</button></form>
  {/if}
  <form method="POST" action="?/resetTotp"><input type="hidden" name="username" value={user.username} /><button type="submit" title="After a lost phone">Reset two-step sign-in</button></form>
  <form method="POST" action="?/endSessions"><input type="hidden" name="username" value={user.username} /><button type="submit">End sessions</button></form>
</div>

<style>
  .user-actions form { margin: 0; }
  .user-actions button { display: block; width: 100%; min-height: 40px; border: 0; border-radius: 7px; background: transparent; padding: 8px 10px; text-align: left; color: #44454a; font-size: 13px; font-weight: 500; }
  .user-actions button:hover { background: #f4f4f5; }
  .user-actions .link-sso { border-top: 1px solid #f0f0f1; margin-top: 4px; padding-top: 6px; }
  .user-actions .link-sso input { box-sizing: border-box; width: 100%; min-height: 36px; border: 1px solid #dedfe2; border-radius: 7px; padding: 6px 8px; font-size: 13px; }
</style>
