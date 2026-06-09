<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';
  import { artClass } from '$lib/art';
  import type { WidgetSize } from '$lib/dashboard';
  import { capForSize } from '$lib/widgetsize';
  import { measureBlock, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';

  let { connectionId, onItemClick, size, rows: _rows, collapsed = false, onGeometry }: {
    connectionId: number;
    onItemClick?: (item: DrawerItem) => void;
    size?: WidgetSize;
    /** Accepted for API consistency but ignored — carousel layout is width-driven. */
    rows?: number;
    collapsed?: boolean;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  let allItems = $state<any[]>([]);
  let imgError = $state<Record<string, boolean>>({});
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // Derive cap and visible slice reactively from size
  // More posters loaded at larger sizes so the carousel has more to scroll through
  const cap = $derived(capForSize(size, { s: 8, m: 16, l: 24, full: 36 }));
  const items = $derived(allItems.slice(0, cap));

  async function load() {
    try {
      const r = await fetch(`/api/widgets/${connectionId}/recentlyAdded`).then((x) => x.json());
      if (r.ok) {
        allItems = (r.data as any[]) ?? [];
        err = '';
      } else {
        err = r.error ?? 'Unknown error';
      }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    load();
    timer = setInterval(load, 300_000); // re-poll every 5 min
  });

  onDestroy(() => {
    if (timer !== undefined) clearInterval(timer);
  });

  function handlePosterClick(it: any) {
    onItemClick?.({
      id: String(it.id),
      title: it.title,
      year: it.year,
      kind: it.kind === 'Series' ? 'series' : 'movie',
      status: 'Available',
      connectionId,
      params: { id: it.id }   // jellyfin item id → playInJellyfin deep link
    });
  }

  // Carousel scroll helpers
  let track: HTMLElement | undefined = $state();

  function scrollLeft() {
    track?.scrollBy({ left: -340, behavior: 'smooth' });
  }

  function scrollRight() {
    track?.scrollBy({ left: 340, behavior: 'smooth' });
  }
</script>

<div class="card">
  <!-- Card header -->
  <div class="ch">
    <h3>
      <a class="ch-link" href={`/list/${connectionId}/recentlyAdded`}>{$_('widget.recentlyAdded.title')}</a>
      {#if !loading && allItems.length > 0}
        <span class="cnt-badge">{allItems.length}</span>
      {/if}
    </h3>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || err || items.length === 0}
    <WidgetState {loading} error={err} empty={!loading && !err && items.length === 0}
      emptyMessage={$_('widget.recentlyAdded.empty')} onRetry={load} settingsHref="/settings" />
  {:else}
    <!-- Carousel -->
    <div class="caro" use:measureBlock={(g) => onGeometry?.(g)}>
      <button class="arw-btn l" onclick={scrollLeft} aria-label="Scroll left">‹</button>
      <div class="track" bind:this={track}>
        {#each items as it}
          <div
            class="poster"
            role="button"
            tabindex="0"
            onclick={() => handlePosterClick(it)}
            onkeydown={(e) => e.key === 'Enter' && handlePosterClick(it)}
          >
            <div class="art {artClass(String(it.id))}">
              {#if it.image && !imgError[String(it.id)]}
                <img
                  class="poster-img"
                  src={`/api/image/${connectionId}?path=${encodeURIComponent(it.image)}`}
                  alt={it.title}
                  loading="lazy"
                  onerror={() => { imgError = { ...imgError, [String(it.id)]: true }; }}
                />
              {/if}
              <span class="badge">{it.kind === 'Series' ? 'SERIES' : 'MOVIE'}</span>
              <div class="play"><span>▶</span></div>
            </div>
            <div class="ttl">{it.title}</div>
            <div class="yr">{it.year ?? ''}</div>
          </div>
        {/each}
      </div>
      <button class="arw-btn r" onclick={scrollRight} aria-label="Scroll right">›</button>
    </div>
  {/if}
</div>

<style>
  .poster-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
</style>
