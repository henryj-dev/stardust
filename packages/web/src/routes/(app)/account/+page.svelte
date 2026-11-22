<script lang="ts">
import PageContainer from "$lib/components/layout/PageContainer.svelte";
import PageHeader from "$lib/components/layout/PageHeader.svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import * as Tabs from "$lib/components/ui/tabs";
import { KeyRound, ShieldCheck, Monitor, KeySquare } from "@lucide/svelte";
import PasswordSettings from "$lib/components/account/PasswordSettings.svelte";
import TwoFactorSettings from "$lib/components/account/TwoFactorSettings.svelte";
import SessionSettings from "$lib/components/account/SessionSettings.svelte";
import TokenSettings from "$lib/components/account/TokenSettings.svelte";

let { data, form } = $props();
const sections = [
  { id: "password", label: "Password", icon: KeyRound },
  { id: "two-factor", label: "Two-step sign-in", icon: ShieldCheck },
  { id: "sessions", label: "Sessions", icon: Monitor },
  { id: "tokens", label: "API tokens", icon: KeySquare },
];

type SectionId = (typeof sections)[number]["id"];
function initialSection(): SectionId {
  if (form?.setup || form?.totpError || form?.totpOff || form?.recoveryCodes) return "two-factor";
  if (form?.sessionError || form?.endedSession) return "sessions";
  if (form?.tokenError || form?.createdToken || form?.revokedToken || form?.confirmed) return "tokens";
  return "password";
}
let active = $state<SectionId>(initialSection());
function syncSection() {
  const id = window.location.hash.slice(1);
  active = sections.some((section) => section.id === id) ? id as SectionId : "password";
}
let orientation = $state<"horizontal" | "vertical">("horizontal");
onMount(() => {
  if (window.location.hash) syncSection();
  const wide = window.matchMedia("(min-width: 768px)");
  const syncOrientation = () => orientation = wide.matches ? "vertical" : "horizontal";
  syncOrientation();
  wide.addEventListener("change", syncOrientation);
  return () => wide.removeEventListener("change", syncOrientation);
});
function selectSection(value: string) {
  void goto(`#${value}`, { shallow: true });
}
</script>

<svelte:window onhashchange={syncSection} />

<svelte:head><title>Settings · stardust</title></svelte:head>

<PageContainer>
  <PageHeader title="Settings" description="Manage your account and security preferences." />
  <Tabs.Root bind:value={active} {orientation} onValueChange={selectSection} class="settings-tabs md:grid md:grid-cols-[180px_minmax(0,1fr)] md:gap-6">
    <Tabs.List label="Account settings" class="mb-4 flex gap-1 overflow-x-auto md:mb-0 md:block">
      {#each sections as section (section.id)}
        <Tabs.Trigger value={section.id} class="flex min-h-10 w-auto shrink-0 items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-[13px] font-medium whitespace-nowrap text-[#66676d] hover:bg-[#efeff0] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0066ff] data-[state=active]:bg-[#f0f1f3] data-[state=active]:text-[#171719] md:w-full"><section.icon size={16} strokeWidth={1.6} aria-hidden="true" />{section.label}</Tabs.Trigger>
      {/each}
    </Tabs.List>
    <div class="min-w-0">
      <Tabs.Content value="password"><PasswordSettings {form} /></Tabs.Content>
      <Tabs.Content value="two-factor"><TwoFactorSettings {data} {form} /></Tabs.Content>
      <Tabs.Content value="sessions"><SessionSettings {data} {form} /></Tabs.Content>
      <Tabs.Content value="tokens"><TokenSettings {data} {form} /></Tabs.Content>
    </div>
  </Tabs.Root>
</PageContainer>
