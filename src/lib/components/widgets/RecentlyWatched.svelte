<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { artClass } from '$lib/art';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import { _ } from 'svelte-i18n';

  let { size, collapsed = false, onTotalItems, onGeometry }: {
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 60_000;
  const ROW_PX = 48; // fallback thumbnail-row height (matches .rw-row CSS; fitRows measures the real row)

  let allItems = $state<any[]>([]);
  let count = $state(0);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;
  // Per-item poster error flag: keyed by index
  let posterErr = $state<Record<number, boolean>>({});

  // How many rows fit the current body height; render that many, capped at data.
  let fit = $state(1);
  const cap = $derived(Math.min(fit, allItems.length || 0));
  const items = $derived(allItems.slice(0, cap));

  // Report total to parent whenever allItems changes
  $effect(() => {
    if (!loading) onTotalItems?.(allItems.length);
  });

  async function load() {
    try {
      const r = await fetch('/api/watch-history').then((x) => x.json());
      allItems = r.items ?? [];
      count = r.count ?? allItems.length;
      posterErr = {};
      err = '';
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    timer = setInterval(load, POLL_MS);
  });

  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  function serverLabel(serverType: string): string {
    if (serverType === 'plex') return 'Plex';
    if (serverType === 'jellyfin') return 'Jellyfin';
    return serverType;
  }

  /** Relative time string: "2m ago", "1h ago", "3d ago", etc. */
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
  <h3>
    {$_('widget.recentlyWatched.title')}
    {#if !loading && count > 0}
      <span class="cnt-badge">{count}</span>
    {/if}
  </h3>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading}
    <p class="w-msg">Loading…</p>
  {:else if err}
    <p class="w-msg err">{err}</p>
  {:else if allItems.length === 0}
    <p class="w-msg">No recent watch activity.</p>
  {:else}
    <div class="rw-list" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each items as it, i}
        <div class="rw-row">
          <div class="thumb {artClass(it.user + it.title)}">
            {#if it.poster && !posterErr[i]}
              <img
                class="thumb-img"
                src={it.poster}
                alt={it.title}
                loading="lazy"
                onerror={() => { posterErr = { ...posterErr, [i]: true }; }}
              />
            {/if}
          </div>
          <div class="rw-detail">
            <div class="rw-head">
              <span class="rw-title">{it.title}</span>
              <span class="server-badge {it.serverType}">{serverLabel(it.serverType)}</span>
            </div>
            <span class="rw-sub">{it.user}</span>
          </div>
          {#if it.when}
            <span class="rw-when">{relativeTime(it.when)}</span>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .w-msg { font-size: 13px; color: var(--sub); padding: 10px 0; }
  .w-msg.err { color: #ff7a92; }

  .rw-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .rw-row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    /* Fixed poster-row height so fit-to-height math is exact — must match ROW_PX.
       flex-shrink:0 keeps each row exactly this tall when the list is packed, so rows
       never compress into each other; overflow:hidden clips any taller inner content. */
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

  .rw-detail {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }

  .rw-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .rw-title {
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

  .rw-sub { font-size: 11px; color: var(--sub); }

  .rw-when {
    font-size: 11px;
    color: var(--sub);
    white-space: nowrap;
    flex-shrink: 0;
    padding-top: 2px;
  }
</style>
