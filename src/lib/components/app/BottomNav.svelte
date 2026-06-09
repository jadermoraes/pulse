<script lang="ts">
  import { _ } from 'svelte-i18n';
  import { page } from '$app/stores';

  // Consumer app navigation. Renders as a bottom tab bar on mobile and a horizontal
  // top nav on wider screens. Active state is derived from the current path.
  const items = [
    { href: '/app', key: 'app.navHome', match: (p: string) => p === '/app' },
    { href: '/app/discover', key: 'app.navDiscover', match: (p: string) => p.startsWith('/app/discover') },
    { href: '/app/requests', key: 'app.navRequests', match: (p: string) => p.startsWith('/app/requests') },
    { href: '/app/chat', key: 'app.navChat', match: (p: string) => p.startsWith('/app/chat') },
    { href: '/app/account', key: 'app.navAccount', match: (p: string) => p.startsWith('/app/account') }
  ];

  const current = $derived($page.url.pathname);
</script>

<nav class="app-nav" aria-label="App navigation">
  {#each items as it (it.href)}
    <a href={it.href} class="nav-item" class:active={it.match(current)} aria-current={it.match(current) ? 'page' : undefined}>
      <span class="nav-icon" aria-hidden="true">
        {#if it.href === '/app'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-8 9 8"/><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>
        {:else if it.href === '/app/discover'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>
        {:else if it.href === '/app/requests'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        {:else if it.href === '/app/chat'}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>
        {/if}
      </span>
      <span class="nav-label">{$_(it.key)}</span>
    </a>
  {/each}
</nav>

<style>
  .app-nav {
    display: flex;
    background: color-mix(in srgb, var(--bg, #0a0d13) 92%, #000);
    border-top: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
  }
  .nav-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    padding: 8px 4px;
    color: var(--sub, #8b95a7);
    text-decoration: none;
    font-size: 10.5px;
    font-weight: 600;
    min-height: 44px;
    transition: color 0.15s;
  }
  .nav-item:hover { color: var(--txt, #e7ecf3); }
  .nav-item.active { color: var(--accent, #28e0a0); }
  .nav-icon { display: grid; place-items: center; }
  .nav-icon svg { width: 22px; height: 22px; }
  .nav-label { line-height: 1; }

  /* Mobile (≤768px): pin to the bottom as a tab bar with safe-area insets. */
  @media (max-width: 768px) {
    .app-nav {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 70;
      padding-bottom: env(safe-area-inset-bottom);
      backdrop-filter: blur(12px);
    }
  }

  /* Wider screens: a compact horizontal top nav, icons beside labels. */
  @media (min-width: 769px) {
    .app-nav {
      border-top: none;
      border-bottom: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
      justify-content: center;
      gap: 6px;
      padding: 8px 12px;
    }
    .nav-item {
      flex: 0 0 auto;
      flex-direction: row;
      gap: 7px;
      padding: 8px 16px;
      border-radius: 10px;
      font-size: 13px;
    }
    .nav-item.active {
      background: color-mix(in srgb, var(--accent, #28e0a0) 11%, transparent);
    }
    .nav-icon svg { width: 18px; height: 18px; }
  }
</style>
