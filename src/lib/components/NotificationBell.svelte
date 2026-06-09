<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { _ } from 'svelte-i18n';
  import { agentUi } from '$lib/agent-ui.svelte';

  type Ev = {
    id: number;
    ts: number;
    source: string;
    type: string;
    severity: 'info' | 'warn' | 'crit';
    title: string;
    body: string | null;
    entityRef: unknown;
    suggestedActions: { label?: string; tool?: string; args?: unknown }[] | null;
    read: boolean;
  };

  let events = $state<Ev[]>([]);
  let unread = $state(0);
  let dropdownOpen = $state(false);
  let timer: ReturnType<typeof setInterval>;
  let wrapEl = $state<HTMLDivElement | null>(null);

  async function load() {
    try {
      const r = await fetch('/api/events?unread=1&limit=30').then((x) => x.json());
      events = r.events ?? [];
      unread = r.unreadCount ?? 0;
    } catch {
      /* keep last good state */
    }
  }

  async function dismiss(id: number) {
    try {
      await fetch('/api/events/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] })
      });
    } catch {
      /* ignore */
    }
    await load();
  }

  // Mark ALL unread events as read (bulk clear-all, not just the visible page).
  async function markAllRead() {
    try {
      await fetch('/api/events/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true })
      });
    } catch {
      /* ignore */
    }
    await load();
  }

  // Deep-link an event into the chat panel with a prefilled prompt.
  function askAgent(ev: Ev) {
    const suggestion = ev.suggestedActions?.[0]?.label;
    const prompt = suggestion
      ? $_('events.askPrompt', { values: { title: ev.title } }) + ` (${suggestion}?)`
      : $_('events.askPrompt', { values: { title: ev.title } });
    agentUi.openWith(prompt);
    dropdownOpen = false;
    void dismiss(ev.id);
  }

  function toggle() {
    dropdownOpen = !dropdownOpen;
    if (dropdownOpen) void load();
  }

  // Close the dropdown on an outside click.
  function onDocClick(e: MouseEvent) {
    if (dropdownOpen && wrapEl && !wrapEl.contains(e.target as Node)) dropdownOpen = false;
  }

  function relTime(ts: number): string {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'now';
    if (min < 60) return `${min}m`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h`;
    return `${Math.floor(hr / 24)}d`;
  }

  onMount(() => {
    void load();
    timer = setInterval(load, 60000);
    document.addEventListener('click', onDocClick);
  });
  onDestroy(() => {
    clearInterval(timer);
    if (typeof document !== 'undefined') document.removeEventListener('click', onDocClick);
  });
</script>

<div class="bell-wrap" bind:this={wrapEl}>
  <button class="bell-btn" onclick={toggle} aria-label={$_('events.title')} aria-expanded={dropdownOpen}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>{#if unread > 0}<span class="bell-badge">{unread > 99 ? '99+' : unread}</span>{/if}
  </button>

  {#if dropdownOpen}
    <div class="bell-feed">
      <header class="bell-feed-head">
        <span>{$_('events.title')}</span>
        {#if events.length > 0}
          <button class="bell-markall" onclick={markAllRead}>{$_('events.dismissAll')}</button>
        {/if}
      </header>
      {#if events.length === 0}
        <p class="bell-empty">{$_('events.allCaughtUp')}</p>
      {:else}
        {#each events as ev (ev.id)}
          <div class="bell-row sev-{ev.severity}">
            <div class="bell-row-main">
              <b>{ev.title}</b>
              {#if ev.body}<span class="bell-row-body">{ev.body}</span>{/if}
              <span class="bell-row-foot">
                <span class="bell-row-src">{ev.source}</span>
                <span>· {relTime(ev.ts)}</span>
              </span>
            </div>
            <div class="bell-row-acts">
              <button class="btn btn-s" onclick={() => askAgent(ev)}>{$_('events.ask')}</button>
              <button class="btn btn-s" onclick={() => dismiss(ev.id)}>{$_('events.dismiss')}</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .bell-feed-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .bell-markall {
    background: none;
    border: none;
    color: var(--accent);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
</style>
