<script lang="ts">
  import '../app.css';
  import Rail from '$lib/components/Rail.svelte';
  import BottomNav from '$lib/components/BottomNav.svelte';
  import TopBar from '$lib/components/TopBar.svelte';
  import AgentChat from '$lib/components/AgentChat.svelte';
  import { _ } from 'svelte-i18n';
  import { agentUi } from '$lib/agent-ui.svelte';
  import { applyTheme, applyCustomTheme, loadCustomColors, applyDensity, loadDensity } from '$lib/theme';
  import { setupI18n } from '$lib/i18n';
  import { isLoading } from 'svelte-i18n';
  import { onMount, untrack } from 'svelte';
  import { page } from '$app/stores';

  let { data, children } = $props();

  // The consumer PWA under /app has its own self-contained shell (top/bottom nav via
  // /app/+layout.svelte). The admin shell (Rail, TopBar, fixed BottomNav, agent FAB) must
  // NOT render on top of it — otherwise the admin's fixed, high-z-index nav overlaps the
  // consumer nav and swallows its link clicks. Render children-only on /app routes.
  const isConsumerApp = $derived($page.url.pathname.startsWith('/app'));

  // Initialise i18n synchronously (on both server and client) with the locale
  // resolved server-side from the cookie — this makes $_ ready before first
  // render, so SSR emits the correct language and there is no en→pt flash.
  // untrack: this is a deliberate one-time read of the initial locale.
  setupI18n(untrack(() => data.locale));

  // Find the first enabled proxmox connection to power the source toggle.
  const proxmoxConnId = $derived(
    (data.connections as Array<{ id: number; type: string; enabled: boolean }>)
      .find((c) => c.type === 'proxmox' && c.enabled)?.id ?? null
  );

  onMount(() => {
    const theme = localStorage.getItem('pulse.theme') ?? 'emerald';
    if (theme === 'custom') {
      applyCustomTheme(loadCustomColors());
    } else {
      applyTheme(theme);
    }
    applyDensity(loadDensity());
  });
</script>

<svelte:head>
  <title>Pulse</title>
</svelte:head>

{#if $isLoading}
  <!-- Dictionaries not ready yet — render nothing to avoid a flash of untranslated text. -->
{:else if isConsumerApp}
  <!-- Consumer PWA: render its own self-contained shell only, never the admin chrome. -->
  {@render children()}
{:else if data.user}
  <div class="shell">
    <Rail />
    <div class="main">
      <TopBar {proxmoxConnId} />
      <div>{@render children()}</div>
    </div>
  </div>
  <BottomNav />
  <!-- Agent assistant: floating launcher + slide-in chat panel (shared open-state store). -->
  <button class="agent-fab" onclick={() => (agentUi.open = !agentUi.open)} aria-label={$_('agent.title')}>✦</button>
  <AgentChat bind:open={agentUi.open} />
{:else}
  {@render children()}
{/if}
