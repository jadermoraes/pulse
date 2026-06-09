<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
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

  const POLL_MS = 8_000;
  const ROW_PX = 56; // fallback thumbnail-row height (matches .stream CSS; fitRows measures the real row)

  let allStreams = $state<any[]>([]);
  let count = $state(0);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;
  // Per-item poster error flag: keyed by index
  let posterErr = $state<Record<number, boolean>>({});

  // How many rows fit the current body height; render that many, capped at data.
  let fit = $state(1);
  const cap = $derived(Math.min(fit, allStreams.length || 0));
  const streams = $derived(allStreams.slice(0, cap));

  // Report total to parent whenever allStreams changes
  $effect(() => {
    if (!loading) onTotalItems?.(allStreams.length);
  });

  async function load() {
    try {
      const r = await fetch('/api/now-playing').then((x) => x.json());
      allStreams = r.streams ?? [];
      count = r.count ?? allStreams.length;
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
</script>

<div class="card">
  <h3>
    {#if !loading && count > 0}<span class="dot"></span>{/if}
    {$_('widget.nowPlaying.title')}
    {#if !loading && count > 0}
      <span class="cnt-badge">{count}</span>
    {/if}
  </h3>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || err || allStreams.length === 0}
    <WidgetState {loading} error={err} empty={!loading && !err && allStreams.length === 0}
      emptyMessage={$_('widget.nowPlaying.empty')} onRetry={load} />
  {:else}
    <div class="streams" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each streams as s, i}
        <div class="stream">
          <div class="thumb {artClass(s.user + s.title)}">
            {#if s.poster && !posterErr[i]}
              <img
                class="thumb-img"
                src={s.poster}
                alt={s.title}
                loading="lazy"
                onerror={() => { posterErr = { ...posterErr, [i]: true }; }}
              />
            {/if}
          </div>
          <div class="sinfo">
            <div class="shead">
              <span class="snm">{s.title}</span>
              <span class="server-badge {s.serverType}">{serverLabel(s.serverType)}</span>
            </div>
            <div class="swho">
              {s.user}
              {#if s.state === 'paused'}
                · <span class="state-paused">paused</span>
              {:else}
                · <span class="state-playing">playing</span>
              {/if}
            </div>
            {#if s.progressPercent > 0}
              <div class="prog"><i style="width:{s.progressPercent}%"></i></div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .streams {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }

  .stream {
    display: flex; align-items: center; gap: 10px;
    /* Fixed thumb-row height so fit-to-height math is exact — must match ROW_PX.
       flex-shrink:0 keeps each row exactly this tall when the list is packed, so rows
       never compress/overlap; overflow:hidden clips any taller inner content. */
    height: 56px;
    flex: 0 0 56px;
    padding: 5px 2px;
    box-sizing: border-box;
    overflow: hidden;
  }

  /* Poster thumbnail */
  .thumb {
    position: relative;
    width: 31px;
    height: 46px;
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

  .sinfo { flex: 1; min-width: 0; }

  .shead {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }

  .snm {
    font-size: 13px;
    font-weight: 500;
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

  .swho { font-size: 11px; color: var(--sub); margin-top: 2px; }

  .state-paused { color: #f9a825; }
  .state-playing { color: #69e08a; }

  .prog {
    margin-top: 4px;
    height: 3px;
    background: var(--border, rgba(255,255,255,0.1));
    border-radius: 2px;
    overflow: hidden;
  }

  .prog i {
    display: block;
    height: 100%;
    background: var(--accent, #00a4dc);
    border-radius: inherit;
  }
</style>
