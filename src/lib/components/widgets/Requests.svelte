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

  const POLL_MS = 300_000; // library cadence (5 min) per spec §6

  let allInflight = $state<any[]>([]);
  let allAvailable = $state(false);
  let imgError = $state<Record<string, boolean>>({});
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // Derive cap and visible slice reactively from size
  const cap = $derived(capForSize(size, { s: 4, m: 8, l: 12, full: 20 }));
  const items = $derived(allInflight.slice(0, cap));

  // On the dashboard card, only show requests that still need attention.
  // "Available" requests are complete — they are shown on the drilldown list page but not here.
  function isInFlight(item: any): boolean {
    return item.state !== 'ok';
  }

  async function load() {
    try {
      const r = await fetch(`/api/widgets/${connectionId}/requests`).then((x) => x.json());
      if (r.ok) {
        const all: any[] = (r.data as any[]) ?? [];
        const inflight = all.filter(isInFlight);
        allInflight = inflight;
        allAvailable = all.length > 0 && inflight.length === 0;
        err = '';
      } else err = r.error ?? 'Unknown error';
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); timer = setInterval(load, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  // state: 'ok' | 'proc' | 'bad' | 'idle'
  function pillClass(state: string): string {
    if (state === 'ok') return 'ok';
    if (state === 'bad') return 'bad';
    if (state === 'idle') return 'idle';
    return 'proc';
  }

  function handleClick(it: any) {
    onItemClick?.({
      id: String(it.id),
      title: it.title,
      kind: 'request',
      status: it.status,
      meta: `Requested by ${it.requestedBy}`,
      connectionId,
      params: { id: it.id, tmdbId: it.tmdbId, mediaType: it.mediaType }
    });
  }

  let track: HTMLElement | undefined = $state();
  function scrollLeft() { track?.scrollBy({ left: -340, behavior: 'smooth' }); }
  function scrollRight() { track?.scrollBy({ left: 340, behavior: 'smooth' }); }
</script>

<div class="card">
  <div class="ch">
    <h3>
      <a class="ch-link" href={`/list/${connectionId}/requests`}>{$_('widget.requests.title')}</a>
      {#if !loading && allInflight.length > 0}<span class="cnt-badge">{allInflight.length}</span>{/if}
    </h3>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || err || items.length === 0}
    <WidgetState
      {loading}
      error={err}
      empty={!loading && !err && items.length === 0}
      emptyMessage={allAvailable ? $_('widget.requests.allAvailable') : $_('widget.requests.empty')}
      onRetry={load}
      settingsHref="/settings"
    />
  {:else}
    <div class="caro" use:measureBlock={(g) => onGeometry?.(g)}>
      <button class="arw-btn l" onclick={scrollLeft} aria-label="Scroll left">‹</button>
      <div class="track" bind:this={track}>
        {#each items as it}
          <div
            class="poster"
            role="button"
            tabindex="0"
            onclick={() => handleClick(it)}
            onkeydown={(e) => e.key === 'Enter' && handleClick(it)}
          >
            <div class="art {artClass(String(it.id))}">
              {#if it.poster && !imgError[String(it.id)]}
                <img
                  class="poster-img"
                  src={it.poster}
                  alt={it.title}
                  loading="lazy"
                  onerror={() => { imgError = { ...imgError, [String(it.id)]: true }; }}
                />
              {/if}
              <span class="pill {pillClass(it.state)} ovl">{it.status}</span>
            </div>
            <div class="ttl">{it.title}</div>
            <div class="yr">by {it.requestedBy}</div>
          </div>
        {/each}
      </div>
      <button class="arw-btn r" onclick={scrollRight} aria-label="Scroll right">›</button>
    </div>
  {/if}
</div>

<style>
  .ovl { position: absolute; top: 8px; left: 8px; }
  .poster-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  /* red pill variant for Declined / Failed */
  .pill.bad {
    background: rgba(255, 92, 122, 0.16);
    color: #ff7a92;
  }
  /* muted pill variant for Unreleased */
  .pill.idle {
    background: rgba(255, 255, 255, 0.08);
    color: var(--sub);
  }
</style>
