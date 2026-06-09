<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import WidgetState from '$lib/components/WidgetState.svelte';
  import { _ } from 'svelte-i18n';

  let { onItemClick, size, collapsed = false, onTotalItems, onGeometry }: {
    onItemClick?: (item: DrawerItem) => void;
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 30_000; // containers cadence per spec §6
  const ROW_PX = 44; // fixed row height (matches .crow CSS)

  let allContainers = $state<any[]>([]);
  let available = $state(true);
  let err = $state('');
  let loading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // How many rows fit the current body height (set by the fitRows ResizeObserver).
  let fit = $state(1);
  // Render exactly the rows that fit, capped at the data we actually have.
  const cap = $derived(Math.min(fit, allContainers.length || 0));
  const containers = $derived(allContainers.slice(0, cap));

  // Report total to parent whenever allContainers changes
  $effect(() => {
    if (!loading) onTotalItems?.(allContainers.length);
  });

  async function load() {
    try {
      const r = await fetch('/api/docker/containers').then((x) => x.json());
      available = r.available !== false;
      allContainers = available ? ((r.containers as any[]) ?? []) : [];
      err = '';
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => { load(); timer = setInterval(load, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });

  function pillKind(state: string): 'ok' | 'proc' {
    return state === 'running' ? 'ok' : 'proc';
  }

  function handleClick(c: any) {
    onItemClick?.({
      id: c.id,
      title: c.name,
      kind: 'container',
      status: c.state,
      meta: `${c.image} · ${c.status}`
    });
  }
</script>

<div class="card">
  <div class="ch">
    <h3>
      <a class="ch-link" href="/list/0/containers">{$_('widget.containers.title')}</a>
      {#if !loading && allContainers.length > 0}<span class="cnt-badge">{allContainers.length}</span>{/if}
    </h3>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if loading || !available || err || allContainers.length === 0}
    <WidgetState
      {loading}
      error={loading ? undefined : (!available ? 'Docker socket unavailable.' : (err || undefined))}
      empty={!loading && available && !err && allContainers.length === 0}
      emptyMessage={$_('widget.containers.empty')}
      onRetry={load}
      settingsHref="/settings"
    />
  {:else}
    <div class="clist" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each containers as c}
        <div
          class="crow"
          role="button"
          tabindex="0"
          onclick={() => handleClick(c)}
          onkeydown={(e) => e.key === 'Enter' && handleClick(c)}
        >
          <span class="cnm">{c.name}</span>
          <span class="pill {pillKind(c.state)}">{c.state}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .clist {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .crow {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; cursor: pointer;
    /* Fixed row height that NEVER compresses — keeps fit-to-height math exact so the
       widget shows a whole number of rows with no clip/overlap when the cell is short. */
    height: var(--row-h, 44px);
    flex: 0 0 var(--row-h, 44px);
    padding: 0 2px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .cnm {
    font-size: 13px; color: var(--txt); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
</style>
