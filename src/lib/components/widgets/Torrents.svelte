<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';

  let { connectionId, onItemClick, size, collapsed = false, onTotalItems, onGeometry }: {
    connectionId: number;
    onItemClick?: (item: DrawerItem) => void;
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 5_000; // downloads cadence per spec §6
  const ROW_PX = 44; // fixed row height (matches .qrow CSS)

  let allTorrents = $state<any[]>([]);
  let dlSpeed = $state(0);
  let upSpeed = $state(0);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // How many rows fit the current body height; render that many, capped at data.
  let fit = $state(1);
  const cap = $derived(Math.min(fit, allTorrents.length || 0));
  const torrents = $derived(allTorrents.slice(0, cap));

  // Report total to parent whenever allTorrents changes
  $effect(() => {
    if (!loading) onTotalItems?.(allTorrents.length);
  });

  function fmtSpeed(bytesPerSec: number): string {
    if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
    if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
    return `${bytesPerSec} B/s`;
  }

  async function load() {
    try {
      const [t, x] = await Promise.all([
        fetch(`/api/widgets/${connectionId}/torrents`).then((r) => r.json()),
        fetch(`/api/widgets/${connectionId}/transfers`).then((r) => r.json())
      ]);
      if (t.ok) { allTorrents = (t.data as any[]) ?? []; err = ''; }
      else err = t.error ?? 'Unknown error';
      if (x.ok) { dlSpeed = (x.data as any)?.dlSpeed ?? 0; upSpeed = (x.data as any)?.upSpeed ?? 0; }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); timer = setInterval(load, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  function pillKind(state: string): 'ok' | 'proc' {
    return state?.toLowerCase().includes('download') ? 'proc' : 'ok';
  }

  function handleClick(t: any) {
    onItemClick?.({
      id: String(t.id),
      title: t.name,
      kind: 'download',
      status: t.state,
      meta: `↓ ${fmtSpeed(t.dlSpeed)} · ↑ ${fmtSpeed(t.upSpeed)}`,
      connectionId,
      params: { hash: t.id }   // qBit torrent id === hash
    });
  }
</script>

<div class="card">
  <div class="ch">
    <h3>
      <a class="ch-link" href={`/list/${connectionId}/torrents`}>{$_('widget.torrents.title')}</a>
      {#if !loading && allTorrents.length > 0}<span class="cnt-badge">{allTorrents.length}</span>{/if}
    </h3>
    <span class="speeds">↓ {fmtSpeed(dlSpeed)} · ↑ {fmtSpeed(upSpeed)}</span>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || err || allTorrents.length === 0}
    <WidgetState {loading} error={err} empty={!loading && !err && allTorrents.length === 0}
      emptyMessage={$_('widget.torrents.empty')} onRetry={load} settingsHref="/settings" />
  {:else}
    <div class="qlist" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each torrents as t}
        <div
          class="qrow"
          role="button"
          tabindex="0"
          onclick={() => handleClick(t)}
          onkeydown={(e) => e.key === 'Enter' && handleClick(t)}
        >
          <div class="qtop">
            <span class="qttl">{t.name}</span>
            <span class="pill {pillKind(t.state)}">{t.state}</span>
          </div>
          <div class="prog"><i style="width:{t.progress}%"></i></div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .speeds { font-size: 12px; color: var(--sub); }
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
</style>
