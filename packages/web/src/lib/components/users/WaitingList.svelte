<script lang="ts">
import type { PageData } from "../../../routes/(app)/admin/users/$types";

let { waiting, users }: { waiting: PageData["waiting"]; users: PageData["users"] } = $props();
/** Accounts single sign-on could still be linked to. */
const unlinked = $derived(users.filter((u) => !u.oidc));
/** A username stardust accepts, from what the provider said; the administrator can change it. */
const suggest = (r: { username: string | null; email: string | null }) =>
  (r.username ?? r.email?.split("@")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
const field =
  "min-h-10 rounded-[10px] border border-[#dedfe2] bg-white px-3 py-2 text-sm text-[#171719] focus:border-[#0066ff] focus:outline-none";
const action =
  "min-h-10 rounded-[10px] border-0 bg-[#171719] px-3 text-sm font-semibold text-white hover:bg-[#2c2c31] focus-visible:outline-2 focus-visible:outline-[#0066ff]";
</script>

{#if waiting.length > 0}
  <section aria-labelledby="waiting-title" class="mb-8">
    <h2 id="waiting-title" class="m-0 border-0 p-0 text-base font-semibold text-[#252529]">Waiting to be let in</h2>
    <p class="mt-1 mb-3 text-sm text-[#777980]">
      People the provider signed in who have no account here, from the audit log. Give one an account, or link them to
      an account that exists.
    </p>
    <ul data-waiting aria-label="Waiting to be let in" class="m-0 list-none border-t border-[#ededee] p-0">
      {#each waiting as r (r.issuer + " " + r.subject)}
        <li data-waiting-subject={r.subject} class="m-0 grid gap-3 border-b border-[#f0f0f1] px-2 py-4">
          <div class="min-w-0">
            <p class="m-0 truncate text-sm font-semibold text-[#252529]">{[r.name, r.username, r.email].filter(Boolean).join(" · ") || "Nothing said"}</p>
            <p class="mt-0.5 mb-0 text-xs break-all text-[#85868c]">
              {r.reason === "no-account" ? "No account" : "Their username belongs to another account"} · last tried
              {new Date(r.at).toLocaleString()}{r.attempts > 1 ? ` (${r.attempts} tries)` : ""} · subject <code>{r.subject}</code>
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <form method="POST" action="?/create" data-waiting-create class="m-0 flex flex-wrap items-center gap-2">
              <input type="hidden" name="subject" value={r.subject} />
              {#if r.issuer}<input type="hidden" name="issuer" value={r.issuer} />{/if}
              <input type="hidden" name="displayName" value={r.name ?? ""} />
              <input name="username" value={suggest(r)} required pattern={"[a-z0-9][a-z0-9._-]{0,62}"} aria-label="Username" autocomplete="off" class={field} />
              <label class="flex items-center gap-1.5 text-sm text-[#44454a]"><input type="checkbox" name="isAdmin" /> Administrator</label>
              <button type="submit" class={action}>Give an account</button>
            </form>
            {#if unlinked.length > 0}
              <form method="POST" action="?/sso" data-waiting-link class="m-0 flex flex-wrap items-center gap-2">
                <input type="hidden" name="subject" value={r.subject} />
              {#if r.issuer}<input type="hidden" name="issuer" value={r.issuer} />{/if}
                <select name="username" aria-label="Account" required class={field}>
                  <!-- No account chosen in advance: linking the wrong one lets this person in as someone else. -->
                  <option value="" selected disabled>Choose an account</option>
                  {#each unlinked as u (u.id)}<option value={u.username}>{u.username}</option>{/each}
                </select>
                <button type="submit" class={action}>Link to this account</button>
              </form>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}
