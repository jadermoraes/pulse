<script lang="ts">
  import '../../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import BottomNav from '$lib/components/app/BottomNav.svelte';
  import InstallPrompt from '$lib/components/app/InstallPrompt.svelte';

  let { children } = $props();

  // Pre-session routes (onboarding + login) are a single centred card with no app nav.
  const isPreSession = $derived(
    $page.url.pathname.startsWith('/app/join') || $page.url.pathname.startsWith('/app/login')
  );

  onMount(() => {
    if ('serviceWorker' in navigator) {
      // Scope to /app/ to match the manifest's scope:/app. The SW is served from the origin
      // root, so the Service-Worker-Allowed: /app/ response header (set in hooks.server.ts)
      // is required for this scoped registration to be accepted.
      navigator.serviceWorker.register('/service-worker.js', { type: 'module', scope: '/app/' }).catch(() => { /* SW optional */ });
    }
  });
</script>

{#if isPreSession}
  <div class="app-shell">
    {@render children()}
  </div>
{:else}
  <div class="app-frame">
    <div class="app-nav-top"><BottomNav /></div>
    <main class="app-content">
      <InstallPrompt />
      {@render children()}
    </main>
    <div class="app-nav-bottom"><BottomNav /></div>
  </div>
{/if}

<style>
  .app-frame {
    min-height: 100vh;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  .app-content {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Mobile (≤768px): the bottom tab bar is fixed (via BottomNav itself); the top nav
     is hidden, and we pad the content so it isn't hidden behind the fixed bar. */
  @media (max-width: 768px) {
    .app-nav-top { display: none; }
    .app-content {
      padding-bottom: calc(64px + env(safe-area-inset-bottom));
    }
  }

  /* Wider screens: the top nav shows inline; the (fixed) bottom bar is hidden. */
  @media (min-width: 769px) {
    .app-nav-bottom { display: none; }
  }
</style>
