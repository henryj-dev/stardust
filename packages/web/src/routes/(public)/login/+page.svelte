<script lang="ts">
import AsciiRipple from "$lib/components/effects/AsciiRipple.svelte";
import Button from "$lib/components/ui/Button.svelte";
import InlineNotice from "$lib/components/ui/InlineNotice.svelte";
import TextField from "$lib/components/ui/TextField.svelte";

let { data, form } = $props();
</script>

<svelte:head>
  <title>Sign in · stardust</title>
</svelte:head>

<div class="min-h-screen overflow-clip [color-scheme:light] bg-[#f7f8fa] px-5 py-8 text-[#171719] antialiased sm:px-8">
  <AsciiRipple />
  <div class="relative mx-auto flex min-h-[calc(100vh-4rem)] max-w-[1120px] flex-col">
    <main class="mx-auto flex w-full max-w-[440px] flex-1 items-center px-0 py-12">
      <div class="grid-frame w-full">
      <h1 class="mb-3 px-6 sm:px-10 text-2xl font-bold tracking-[-0.03em] text-[#171719]">Stardust</h1>
      <section class="grid-panel w-full p-6 sm:p-10">
        {#if !form?.secondFactor && (form?.error ?? data.error)}
          <div class="mb-4"><InlineNotice>{form?.error ?? data.error}</InlineNotice></div>
        {/if}

        {#if form?.secondFactor}
          <form method="POST" action={`?/code&next=${encodeURIComponent(data.next)}`} data-second-factor class="m-0 grid gap-4">
            <TextField id="code" name="code" label="Authenticator or recovery code" autocomplete="one-time-code" error={form?.error} required />
            <Button type="submit">Continue</Button>
          </form>
        {:else}
          {#if data.oidc}
            <form method="POST" action="?/oidc" class="m-0">
              <Button type="submit" variant="secondary">Continue with {data.oidc.displayName}</Button>
            </form>
            <div class="my-4 flex items-center gap-3 text-xs text-[#92949b]" aria-hidden="true">
              <span class="h-px flex-1 bg-[#eaebed]"></span><span>or</span><span class="h-px flex-1 bg-[#eaebed]"></span>
            </div>
          {/if}
          <form method="POST" action={`?/password&next=${encodeURIComponent(data.next)}`} class="m-0 grid gap-4">
            <TextField id="username" name="username" label="Username" autocomplete="username" value={form?.username ?? ""} required />
            <TextField id="password" name="password" label="Password" type="password" autocomplete="current-password" required />
            <Button type="submit">Sign in</Button>
          </form>
        {/if}
      </section>
      </div>
    </main>

  </div>
</div>

<style>
  .grid-frame {
    position: relative;
    isolation: isolate;
  }

  .grid-frame::before,
  .grid-frame::after {
    position: absolute;
    z-index: -1;
    top: 50%;
    width: 1px;
    height: 200vh;
    background: #e8eaed;
    content: "";
    pointer-events: none;
    transform: translateY(-50%);
  }

  .grid-frame::before { left: 0; }
  .grid-frame::after { right: 0; }

  .grid-panel { position: relative; }

  .grid-panel::before,
  .grid-panel::after {
    position: absolute;
    z-index: -1;
    left: 50%;
    width: 200vw;
    height: 1px;
    background: #e8eaed;
    content: "";
    pointer-events: none;
    transform: translateX(-50%);
  }

  .grid-panel::before { top: 0; }
  .grid-panel::after { bottom: 0; }
</style>
