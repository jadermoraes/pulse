<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { WidgetSize } from '$lib/dashboard';
  import { fitRows, type RowGeometry } from '$lib/fitrows';
  import { _ } from 'svelte-i18n';

  let { connectionId, size, collapsed = false, onTotalItems, onGeometry }: {
    connectionId: number;
    size?: WidgetSize;
    collapsed?: boolean;
    onTotalItems?: (total: number) => void;
    onGeometry?: (geom: RowGeometry) => void;
  } = $props();

  const POLL_MS = 300_000; // library/stats cadence (5 min)
  const ROW_PX = 44; // fixed row height (matches .ws-row CSS)

  let allPopularItems = $state<any[]>([]);
  let popularErr = $state('');
  let popularLoading = $state(true);
  let timer: ReturnType<typeof setInterval> | undefined;

  // How many rows fit the current body height; render that many, capped at data.
  let fit = $state(1);
  const cap = $derived(Math.min(fit, allPopularItems.length || 0));
  const popularItems = $derived(allPopularItems.slice(0, cap));

  // Report total to parent whenever data changes
  $effect(() => {
    if (!popularLoading) onTotalItems?.(allPopularItems.length);
  });

  async function loadPopular() {
    try {
      const r = await fetch(`/api/widgets/${connectionId}/popular`).then((x) => x.json());
      if (r.ok) { allPopularItems = (r.data as any[]) ?? []; popularErr = ''; }
      else popularErr = r.error ?? 'Unknown error';
    } catch (e) {
      popularErr = (e as Error).message;
    } finally {
      popularLoading = false;
    }
  }

  onMount(() => { loadPopular(); timer = setInterval(loadPopular, POLL_MS); });
  onDestroy(() => { if (timer !== undefined) clearInterval(timer); });
</script>

<div class="card">
  <div class="ch">
    <h3>
      {$_('widget.mostWatched.title')}
      {#if !popularLoading && allPopularItems.length > 0}<span class="cnt-badge">{allPopularItems.length}</span>{/if}
    </h3>
  </div>

  {#if collapsed}
    <!-- collapsed: header only -->
  {:else if popularLoading}
    <p class="w-msg">Loading…</p>
  {:else if popularErr}
    <p class="w-msg err">{popularErr}</p>
  {:else if allPopularItems.length === 0}
    <p class="w-msg">No watch stats yet.</p>
  {:else}
    <div class="ws-list" use:fitRows={{ rowPx: ROW_PX, onFit: (n) => (fit = n), onGeometry }}>
      {#each popularItems as it}
        <div class="ws-row">
          <span class="ws-nm">{it.title}</span>
          <span class="pill ok">{it.plays} plays</span>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .w-msg { font-size: 13px; color: var(--sub); padding: 10px 0; }
  .w-msg.err { color: #ff7a92; }
  .ws-list {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
  }
  .ws-row {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    /* Fixed, non-compressing row height — keeps fit-to-height math exact (no clip). */
    height: var(--row-h, 44px);
    flex: 0 0 var(--row-h, 44px);
    padding: 0 2px;
    box-sizing: border-box;
    overflow: hidden;
  }
  .ws-nm { font-size: 13px; color: var(--txt); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
