<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { browser as isBrowser } from '$app/environment';
  import { artClass } from '$lib/art';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';

  let { size, collapsed = false, onTotalItems, onGeometry }: {
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_RECENT_MS = 60_000;   // recently watched: 1 minute
  const POLL_TOP_MS    = 300_000;  // most watched: 5 minutes
  const ROW_PX = 48;
  const LS_KEY = 'pulse_watch_view';

  type View = 'recent' | 'top';

  let view = $state<View>('recent');

  // Per-view data
  let recentItems = $state<any[]>([]);
  let recentCount = $state(0);
  let recentErr   = $state('');
  let recentLoading = $state(true);

  let topItems = $state<any[]>([]);
  let topCount = $state(0);
  let topErr   = $state('');
  let topLoading = $state(true);

  // Poster error flags per view
  let recentPosterErr = $state<Record<number, boolean>>({});
  let topPosterErr    = $state<Record<number, boolean>>({});

  // Derived: active-view data
  const allItems  = $derived(view === 'recent' ? recentItems : topItems);
  const count     = $derived(view === 'recent' ? recentCount : topCount);
  const activeErr = $derived(view === 'recent' ? recentErr   : topErr);
  const loading   = $derived(view === 'recent' ? recentLoading : topLoading);
  const posterErr = $derived(view === 'recent' ? recentPosterErr : topPosterErr);

  // fitRows state
  let fit = $state(1);
  const cap   = $derived(Math.min(fit, allItems.length || 0));
  const items = $derived(allItems.slice(0, cap));

  // Report total to parent
  $effect(() => {
    if (!loading) onTotalItems?.(allItems.length);
  });

  let recentTimer: ReturnType<typeof setInterval> | undefined;
  let topTimer:    ReturnType<typeof setInterval> | undefined;

  async function loadRecent() {
    try {
      const r = await fetch('/api/watch-history').then((x) => x.json());
      recentItems = r.items ?? [];
      recentCount = r.count ?? recentItems.length;
      recentPosterErr = {};
      recentErr = '';
    } catch (e) {
      recentErr = (e as Error).message;
    } finally {
      recentLoading = false;
    }
  }

  async function loadTop() {
    try {
      const r = await fetch('/api/most-watched').then((x) => x.json());
      topItems = r.items ?? [];
      topCount = r.count ?? topItems.length;
      topPosterErr = {};
      topErr = '';
    } catch (e) {
      topErr = (e as Error).message;
    } finally {
      topLoading = false;
    }
  }

  function setView(v: View, e: MouseEvent) {
    e.stopPropagation();
    view = v;
    if (isBrowser) localStorage.setItem(LS_KEY, v);
    fit = 1;
  }

  onMount(() => {
    if (isBrowser) {
      const saved = localStorage.getItem(LS_KEY) as View | null;
      if (saved === 'recent' || saved === 'top') view = saved;
    }
    loadRecent();
    loadTop();
    recentTimer = setInterval(loadRecent, POLL_RECENT_MS);
    topTimer    = setInterval(loadTop,    POLL_TOP_MS);
  });

  onDestroy(() => {
    if (recentTimer !== undefined) clearInterval(recentTimer);
    if (topTimer    !== undefined) clearInterval(topTimer);
  });

  function serverLabel(serverType: string): string {
    if (serverType === 'plex')     return 'Plex';
    if (serverType === 'jellyfin') return 'Jellyfin';
    return serverType;
  }

  function relativeTime(iso: string): string {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return '';
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 2) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
</script>

<div class="card">
  <div class="ch">
    <h3>
      {$_('widget.watchActivity.title')}
      {#if !loading && count > 0}
        <span class="cnt-badge">{count}</span>
      {/if}
    </h3>
    <!-- Segmented toggle: Recent / Top -->
    <div class="view-toggle" role="group" aria-label="Watch view">
      <button
        class="vt-btn"
        class:vt-active={view === 'recent'}
        onclick={(e) => setView('recent', e)}
        title={$_('widget.watchActivity.recentTitle')}
      >{$_('widget.watchActivity.recent')}</button>
      <button
        class="vt-btn"
        class:vt-active={view === 'top'}
        onclick={(e) => setView('top', e)}
        title={$_('widget.watchActivity.topTitle')}
      >{$_('widget.watchActivity.top')}</button>
    </div>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || activeErr || allItems.length === 0}
    <WidgetState
      {loading}
      error={activeErr}
      empty={!loading && !activeErr && allItems.length === 0}
      emptyMessage={view === 'recent' ? $_('widget.watchActivity.emptyRecent') : $_('widget.watchActivity.emptyStats')}
      onRetry={view === 'recent' ? loadRecent : loadTop}
    />
  {:else if view === 'recent'}
    <div class="wa-list" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each items as it, i}
        <div class="wa-row">
          <div class="thumb {artClass(it.user + it.title)}">
            {#if it.poster && !recentPosterErr[i]}
              <img
                class="thumb-img"
                src={it.poster}
                alt={it.title}
                loading="lazy"
                onerror={() => { recentPosterErr = { ...recentPosterErr, [i]: true }; }}
              />
            {/if}
          </div>
          <div class="wa-detail">
            <div class="wa-head">
              <span class="wa-title">{it.title}</span>
              <span class="server-badge {it.serverType}">{serverLabel(it.serverType)}</span>
            </div>
            <span class="wa-sub">{it.user}</span>
          </div>
          {#if it.when}
            <span class="wa-when">{relativeTime(it.when)}</span>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="wa-list" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each items as it, i}
        <div class="wa-row">
          <div class="thumb {artClass(it.title)}">
            {#if it.poster && !topPosterErr[i]}
              <img
                class="thumb-img"
                src={it.poster}
                alt={it.title}
                loading="lazy"
                onerror={() => { topPosterErr = { ...topPosterErr, [i]: true }; }}
              />
            {/if}
          </div>
          <div class="wa-detail">
            <div class="wa-head">
              <span class="wa-title">{it.title}</span>
              <span class="server-badge {it.serverType}">{serverLabel(it.serverType)}</span>
            </div>
            <span class="plays-pill">{it.plays} plays</span>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  /* Header row: title + badge on the left, toggle on the right.
     padding-right reserves space for the WidgetFrame corner control (⋯ button at
     ~right:12px from the cell edge). The card itself has 14px right padding, so
     the ⋯ sits ~36px from the content right edge; clearing 40px keeps the toggle
     fully clear in both normal mode and edit mode (edit mode hides the header via
     visibility:hidden, so only normal mode matters for clickability). */
  .ch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-right: 40px;
  }

  .ch h3 {
    margin: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Segmented toggle — mirrors ServerStats .src-toggle / .src-btn style.
     z-index: 5 keeps the toggle above the WidgetFrame corner control (z-index: 4)
     should the reserved padding above ever be tight on a narrow widget. */
  .view-toggle {
    display: flex;
    align-items: center;
    gap: 2px;
    flex-shrink: 0;
    position: relative;
    z-index: 5;
  }

  .vt-btn {
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--sub);
    cursor: pointer;
    line-height: 1.4;
    transition: color 0.12s, background 0.12s, border-color 0.12s;
  }

  .vt-btn:hover {
    color: var(--txt);
    background: rgba(255, 255, 255, 0.06);
  }

  .vt-btn.vt-active {
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  }

  /* List container */
  .wa-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  /* Row */
  .wa-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 48px;
    flex: 0 0 48px;
    padding: 4px 2px;
    box-sizing: border-box;
    overflow: hidden;
  }

  /* Poster thumbnail */
  .thumb {
    position: relative;
    width: 27px;
    height: 40px;
    border-radius: 4px;
    flex-shrink: 0;
    overflow: hidden;
  }

  .thumb-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }

  .wa-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .wa-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .wa-title {
    font-size: 13px;
    color: var(--txt);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .server-badge {
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .server-badge.plex {
    background: rgba(229, 160, 13, 0.18);
    color: #e5a00d;
    border: 1px solid rgba(229, 160, 13, 0.3);
  }

  .server-badge.jellyfin {
    background: rgba(0, 164, 220, 0.15);
    color: #00a4dc;
    border: 1px solid rgba(0, 164, 220, 0.28);
  }

  .wa-sub {
    font-size: 11px;
    color: var(--sub);
  }

  .wa-when {
    font-size: 11px;
    color: var(--sub);
    white-space: nowrap;
    flex-shrink: 0;
    padding-top: 2px;
  }

  .plays-pill {
    font-size: 11px;
    color: var(--sub);
  }
</style>
