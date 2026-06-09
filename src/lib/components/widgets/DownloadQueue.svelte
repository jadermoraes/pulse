<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';

  let { connectionId, label, onItemClick, size, collapsed = false, onTotalItems, onGeometry }: {
    connectionId: number;
    label: string;
    onItemClick?: (item: DrawerItem) => void;
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 5_000; // downloads cadence per spec §6
  const QUEUE_ROW_PX = 44; // matches .qrow CSS
  const WANTED_ROW_PX = 70; // matches .wrow (poster) CSS

  let allQueue = $state<any[]>([]);
  let wantedCount = $state<number | null>(null);
  let allWantedItems = $state<any[]>([]);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // The visible list is either the queue or wanted items (mutually exclusive)
  const totalVisible = $derived(allQueue.length > 0 ? allQueue.length : allWantedItems.length);
  // How many rows fit the current body height; render that many, capped at data.
  let fit = $state(1);
  const queue = $derived(allQueue.slice(0, Math.min(fit, allQueue.length || 0)));
  const wantedItems = $derived(allWantedItems.slice(0, Math.min(fit, allWantedItems.length || 0)));

  // Report total to parent whenever data changes
  $effect(() => {
    if (!loading) onTotalItems?.(totalVisible);
  });

  async function load() {
    try {
      const [q, w] = await Promise.all([
        fetch(`/api/widgets/${connectionId}/queue`).then((x) => x.json()),
        fetch(`/api/widgets/${connectionId}/wanted`).then((x) => x.json())
      ]);
      if (q.ok) { allQueue = (q.data as any[]) ?? []; err = ''; }
      else err = q.error ?? 'Unknown error';
      if (w.ok) {
        wantedCount = (w.data as any)?.count ?? null;
        allWantedItems = (w.data as any)?.items ?? [];
      } else {
        wantedCount = null;
        allWantedItems = [];
      }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); timer = setInterval(load, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  function pillKind(status: string): 'ok' | 'proc' {
    return status?.toLowerCase() === 'downloading' ? 'proc' : 'ok';
  }

  function handleClick(it: any) {
    onItemClick?.({
      id: String(it.id),
      title: it.title,
      kind: label === 'Sonarr' ? 'series' : 'movie',
      status: it.status,
      meta: `${label} · ${it.progress}%`,
      connectionId,
      // queue rows carry the queue id; deleteQueue uses it. research/manageLink need movie/series id —
      // not present on a queue row, so those buttons surface the upstream "missing id" message gracefully.
      params: { id: it.id }
    });
  }

  function handleWantedClick(it: any) {
    onItemClick?.({
      id: String(it.imdbId ?? it.title ?? ''),
      title: it.title,
      year: it.year,
      kind: label === 'Sonarr' ? 'series' : 'movie',
      status: it.status ?? 'wanted',
      meta: `${label} · ${it.year ?? ''}`,
      connectionId,
      params: {}
    });
  }

  function formatDate(d: string | null): string {
    if (!d) return '';
    try {
      return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return d;
    }
  }

  // Show wanted items when queue is empty and there are wanted items
  const showWanted = $derived(allQueue.length === 0 && allWantedItems.length > 0);
</script>

<div class="card">
  <div class="ch">
    <h3>
      {#if !loading && allQueue.length === 0 && allWantedItems.length > 0}
        <a class="ch-link" href={`/list/${connectionId}/wanted`}>{label}</a>
      {:else}
        <a class="ch-link" href={`/list/${connectionId}/queue`}>{label} {$_('widget.queue.suffix')}</a>
      {/if}
      {#if !loading && allQueue.length > 0}<span class="cnt-badge">{allQueue.length}</span>{/if}
    </h3>
    {#if wantedCount != null && wantedCount > 0}
      <a class="pill proc wanted-link" href={`/list/${connectionId}/wanted`}>{wantedCount} wanted</a>
    {/if}
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || (err && allQueue.length === 0 && !showWanted)}
    <WidgetState {loading} error={err} onRetry={load} settingsHref="/settings" />
  {:else if allQueue.length > 0}
    <div class="qlist" use:fitRows={{ rowPx: QUEUE_ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each queue as it}
        <div
          class="qrow"
          role="button"
          tabindex="0"
          onclick={() => handleClick(it)}
          onkeydown={(e) => e.key === 'Enter' && handleClick(it)}
        >
          <div class="qtop">
            <span class="qttl">{it.title}</span>
            <span class="pill {pillKind(it.status)}">{it.status}</span>
          </div>
          <div class="prog"><i style="width:{it.progress}%"></i></div>
        </div>
      {/each}
    </div>
  {:else if showWanted}
    <p class="section-label">Wanted</p>
    <div class="wlist" use:fitRows={{ rowPx: WANTED_ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each wantedItems as it}
        <div
          class="wrow"
          role="button"
          tabindex="0"
          onclick={() => handleWantedClick(it)}
          onkeydown={(e) => e.key === 'Enter' && handleWantedClick(it)}
        >
          <div class="wthumb">
            {#if it.poster}
              <img class="wpost" src={it.poster} alt={it.title} loading="lazy" />
            {:else}
              <div class="wpost-placeholder"></div>
            {/if}
          </div>
          <div class="winfo">
            <span class="wttl">{it.title}</span>
            <span class="wmeta">
              {it.year ?? ''}
              {#if it.releaseDate}· {formatDate(it.releaseDate)}{/if}
              {#if it.status && it.status !== 'wanted'} · <span class="wpill">{it.status}</span>{/if}
            </span>
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <WidgetState empty={true} emptyMessage={$_('widget.queue.empty')} />
  {/if}
</div>

<style>
  .qlist {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .qrow {
    cursor: pointer;
    /* Fixed, non-compressing row height — keeps fit-to-height math exact (no clip). */
    height: var(--row-h, 44px);
    flex: 0 0 var(--row-h, 44px);
    padding: 0 2px;
    box-sizing: border-box;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .qtop {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px;
  }
  .qttl {
    font-size: 13px; color: var(--txt); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .wanted-link {
    text-decoration: none;
    cursor: pointer;
  }
  .wanted-link:hover { opacity: 0.85; }
  .section-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: var(--sub); margin: 0 0 8px 0;
  }
  .wlist {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .wrow {
    display: flex; align-items: center; gap: 10px;
    cursor: pointer; border-radius: 4px;
    /* Fixed, non-compressing row height so fit-to-height math is exact — matches WANTED_ROW_PX. */
    height: 70px;
    flex: 0 0 70px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .wrow:hover { background: rgba(255,255,255,.04); }
  .wthumb { flex-shrink: 0; }
  .wpost {
    width: 36px; height: 54px; object-fit: cover;
    border-radius: 3px; display: block;
  }
  .wpost-placeholder {
    width: 36px; height: 54px; border-radius: 3px;
    background: var(--sub-bg, rgba(255,255,255,.06));
  }
  .winfo {
    display: flex; flex-direction: column; gap: 3px; min-width: 0;
  }
  .wttl {
    font-size: 13px; color: var(--txt); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .wmeta { font-size: 11px; color: var(--sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wpill {
    display: inline-block; font-size: 10px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase; color: var(--sub);
  }
</style>
