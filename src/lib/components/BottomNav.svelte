<script lang="ts">
  import { page } from '$app/stores';
  import { _ } from 'svelte-i18n';

  // Active route detection: mark active when pathname starts with href (root is exact).
  function isActive(href: string): boolean {
    const p = $page.url.pathname;
    if (href === '/') return p === '/';
    return p.startsWith(href);
  }
</script>

<!-- Mobile-only bottom tab bar. Hidden on desktop via the .bottom-nav media query in app.css. -->
<nav class="bottom-nav" aria-label="Primary">
  <a href="/" class:active={isActive('/')} aria-current={isActive('/') ? 'page' : undefined}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
    <span>{$_('nav.dashboard')}</span>
  </a>

  <a href="/server" class:active={isActive('/server')} aria-current={isActive('/server') ? 'page' : undefined}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="2" y="4" width="20" height="6" rx="1.5" />
      <rect x="2" y="14" width="20" height="6" rx="1.5" />
      <circle cx="6.5" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="6.5" cy="17" r="1" fill="currentColor" stroke="none" />
    </svg>
    <span>{$_('nav.server')}</span>
  </a>

  <a href="/messages" class:active={isActive('/messages')} aria-current={isActive('/messages') ? 'page' : undefined}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
    </svg>
    <span>{$_('nav.messages')}</span>
  </a>

  <a href="/settings" class:active={isActive('/settings')} aria-current={isActive('/settings') ? 'page' : undefined}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-4l-.3 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.8h4l.3-2.8a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1Z" />
    </svg>
    <span>{$_('nav.settings')}</span>
  </a>
</nav>

<style>
  /* Fixed bottom navigation — only shown on mobile (see app.css media query that toggles
     display). Default display:none keeps it out of the desktop layout entirely. */
  .bottom-nav {
    display: none;
  }

  @media (max-width: 768px) {
    .bottom-nav {
      display: flex;
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 70;
      justify-content: space-around;
      align-items: stretch;
      background: color-mix(in srgb, var(--bg) 92%, #000);
      border-top: 1px solid var(--card-brd);
      backdrop-filter: blur(12px);
      padding-bottom: env(safe-area-inset-bottom);
    }

    .bottom-nav a {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 3px;
      min-height: 56px;
      padding: 8px 4px;
      color: var(--sub);
      text-decoration: none;
      font-size: 11px;
      font-weight: 600;
    }

    .bottom-nav a.active {
      color: var(--accent);
    }

    .bottom-nav svg {
      width: 22px;
      height: 22px;
    }
  }
</style>
