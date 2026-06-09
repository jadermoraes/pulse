<script lang="ts">
  import { page } from '$app/stores';
  import { _ } from 'svelte-i18n';
  import { agentUi } from '$lib/agent-ui.svelte';

  // Active route detection: mark the link active when pathname starts with the href
  function isActive(href: string): boolean {
    const p = $page.url.pathname;
    if (href === '/') return p === '/';
    return p.startsWith(href);
  }
</script>

<nav class="rail">
  <!-- Logo / EKG brand mark -->
  <a href="/" class="logo" title={$_('nav.dashboard')}>
    <svg viewBox="0 0 24 24" fill="none" stroke="#0a0d13" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 12h4l2-7 4 14 2-7h4" />
    </svg>
  </a>

  <div class="nav">
    <!-- Dashboard -->
    <a href="/" class:active={isActive('/')} title={$_('nav.dashboard')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </svg>
    </a>

    <!-- Server -->
    <a href="/server" class:active={isActive('/server')} title={$_('nav.server')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="2" y="4" width="20" height="6" rx="1.5" />
        <rect x="2" y="14" width="20" height="6" rx="1.5" />
        <circle cx="6.5" cy="7" r="1" fill="currentColor" stroke="none" />
        <circle cx="6.5" cy="17" r="1" fill="currentColor" stroke="none" />
      </svg>
    </a>

    <!-- Messages (admin inbox: viewer ↔ admin) -->
    <a href="/messages" class:active={isActive('/messages')} title={$_('nav.messages')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5Z" />
      </svg>
    </a>

    <!-- Assistant (opens the agent chat panel) -->
    <button type="button" class="rail-agent" class:active={agentUi.open} title={$_('agent.title')} onclick={() => (agentUi.open = true)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.4L12 15l-1.9-4.6L5.5 9l4.6-1.4L12 3Z" />
        <path d="M19 14l.7 1.8L21.5 16.5l-1.8.7L19 19l-.7-1.8L16.5 16.5l1.8-.7L19 14Z" />
      </svg>
    </button>

    <!-- Settings (gear) — pinned to the bottom via margin-top: auto -->
    <a href="/settings" class:active={isActive('/settings')} title={$_('nav.settings')} style="margin-top: auto;">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-4l-.3 2.6a7 7 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 2.8h4l.3-2.8a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1Z" />
      </svg>
    </a>
  </div>
</nav>
