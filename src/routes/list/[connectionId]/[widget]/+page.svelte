<script lang="ts">
  import { onMount } from 'svelte';
  import { listConfig, sortRows, type ListConfig } from '$lib/listconfig';
  import { artClass } from '$lib/art';
  import Drawer from '$lib/components/Drawer.svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';

  let { data } = $props();

  // data from server load is static (doesn't change after page load).
  // Use $derived so Svelte's rune compiler is satisfied.
  const type = $derived(data.type);
  const widget = $derived(data.widget);
  const connectionId = $derived(data.connectionId);
  const title = $derived(data.title);
  const grid = $derived(data.grid);

  const isDocker = $derived(type === 'docker');
  const cfg = $derived<ListConfig | null>(isDocker ? null : listConfig(type, widget) ?? null);

  let rows = $state<any[]>([]);
  let imgError = $state<Record<string, boolean>>({});
  let err = $state('');
  let loading = $state(true);

  const dockerSorts = [
    { id: 'name', label: 'Name A–Z', key: (r: any) => String(r.name ?? '').toLowerCase(), dir: 'asc' as const },
    { id: 'state', label: 'State', key: (r: any) => String(r.state ?? ''), dir: 'asc' as const }
  ];

  let sortId = $state('');
  let view = $state<'grid' | 'list'>('list');

  const sorts = $derived(isDocker ? dockerSorts : cfg!.sorts);
  const activeSort = $derived(sorts.find((s) => s.id === sortId) ?? sorts[0]);
  const sorted = $derived(activeSort ? sortRows(rows, activeSort.key, activeSort.dir) : rows);

  let drawerOpen = $state(false);
  let drawerItem = $state<DrawerItem | null>(null);

  async function load() {
    try {
      if (isDocker) {
        const r = await fetch('/api/docker/containers').then((x) => x.json());
        if (r.available === false) { rows = []; err = 'Docker socket unavailable.'; }
        else { rows = (r.containers as any[]) ?? []; err = ''; }
      } else {
        const r = await fetch(`/api/widgets/${connectionId}/${widget}`).then((x) => x.json());
        if (r.ok) {
          // Some widgets (e.g. wanted) return { count, items } instead of a flat array.
          const d = r.data;
          rows = Array.isArray(d) ? d : (Array.isArray(d?.items) ? d.items : []);
          err = '';
        }
        else err = r.error ?? 'Unknown error';
      }
    } catch (e) {
      err = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    sortId = isDocker ? 'name' : (cfg?.sorts[0]?.id ?? '');
    view = grid ? 'grid' : 'list';
    load();
  });

  function dockerDrawerItem(row: any): DrawerItem {
    return { id: row.id, title: row.name, kind: 'container', status: row.state, meta: `${row.image} · ${row.status}` };
  }

  function openRow(row: any) {
    drawerItem = isDocker ? dockerDrawerItem(row) : cfg!.toDrawerItem(row, connectionId);
    drawerOpen = true;
  }

  // Per-row quick action (reuses the action layer). Re-loads on success.
  let rowMsg = $state('');
  async function quickAction(row: any, actionId: string, deepLink = false) {
    rowMsg = '…';
    try {
      if (isDocker) {
        const res = await fetch(`/api/docker/containers/${encodeURIComponent(row.id)}/${actionId}`, { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        rowMsg = body.message ?? body.error ?? (body.ok ? 'Done.' : `Failed (${res.status})`);
        if (body.ok) load();
        return;
      }
      const di = cfg!.toDrawerItem(row, connectionId);
      const res = await fetch(`/api/actions/${connectionId}/${actionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(di.params ?? {})
      });
      const body = await res.json().catch(() => ({}));
      if (deepLink && body.ok && body.url) { window.open(body.url, '_blank', 'noopener'); rowMsg = 'Opened.'; }
      else { rowMsg = body.message ?? (body.ok ? 'Done.' : `Failed (${res.status})`); if (body.ok) load(); }
    } catch (e) {
      rowMsg = (e as Error).message;
    }
  }

  // Per-type compact row actions (icon buttons) — a subset of the drawer's, the most common ones.
  function rowActions(): Array<{ icon: string; title: string; actionId: string; deepLink?: boolean }> {
    switch (type) {
      case 'seerr':
        return [
          { icon: '✓', title: 'Approve', actionId: 'approve' },
          { icon: '✕', title: 'Decline', actionId: 'decline' }
        ];
      case 'radarr':
      case 'sonarr':
        return [{ icon: '🗑', title: 'Remove from queue', actionId: 'deleteQueue' }];
      case 'qbittorrent':
        return [
          { icon: '⏸', title: 'Pause', actionId: 'pause' },
          { icon: '🗑', title: 'Remove', actionId: 'delete' }
        ];
      case 'jellyfin':
        return [{ icon: '▶', title: 'Play in Jellyfin', actionId: 'playInJellyfin', deepLink: true }];
      case 'docker':
        return [
          { icon: '↻', title: 'Restart', actionId: 'restart' },
          { icon: '■', title: 'Stop', actionId: 'stop' }
        ];
      default:
        return [];
    }
  }
</script>

<div class="lp-head">
  <a href="/" class="back" aria-label="Back to dashboard">‹</a>
  <h2>{title}</h2>
  {#if !loading}<span class="cnt-pill">{rows.length}</span>{/if}
  <div class="toolbar">
    {#if grid}
      <div class="seg">
        <span class:sel={view === 'grid'} role="button" tabindex="0"
          onclick={() => (view = 'grid')} onkeydown={(e) => e.key === 'Enter' && (view = 'grid')} title="Grid">▦</span>
        <span class:sel={view === 'list'} role="button" tabindex="0"
          onclick={() => (view = 'list')} onkeydown={(e) => e.key === 'Enter' && (view = 'list')} title="List">≣</span>
      </div>
    {/if}
    <select class="sortsel" bind:value={sortId} title="Sort">
      {#each sorts as s}<option value={s.id}>Sort: {s.label}</option>{/each}
    </select>
  </div>
</div>

{#if loading}
  <p class="lp-empty">Loading…</p>
{:else if err}
  <p class="lp-err">{err}</p>
{:else if sorted.length === 0}
  <p class="lp-empty">Nothing here yet.</p>
{:else if grid && view === 'grid'}
  <div class="lp-grid">
    {#each sorted as row}
      <div class="poster" role="button" tabindex="0"
        onclick={() => openRow(row)} onkeydown={(e) => e.key === 'Enter' && openRow(row)}>
        <div class="art {artClass(String(row.id ?? row.title))}">
          {#if row.poster && !imgError[String(row.id ?? row.title)]}
            <img
              class="poster-img"
              src={row.poster}
              alt={row.title}
              loading="lazy"
              onerror={() => { imgError = { ...imgError, [String(row.id ?? row.title)]: true }; }}
            />
          {:else if row.image && !imgError[String(row.id)]}
            <img
              class="poster-img"
              src={`/api/image/${connectionId}?path=${encodeURIComponent(row.image)}`}
              alt={row.title}
              loading="lazy"
              onerror={() => { imgError = { ...imgError, [String(row.id)]: true }; }}
            />
          {/if}
          <span class="badge">{(row.kind ?? 'Movie') === 'Series' ? 'SERIES' : 'MOVIE'}</span>
        </div>
        <div class="ttl">{row.title}</div>
        <div class="yr">{row.year ?? ''}</div>
      </div>
    {/each}
  </div>
{:else}
  <div>
    {#each sorted as row}
      <div class="lp-row" role="button" tabindex="0"
        onclick={() => openRow(row)} onkeydown={(e) => e.key === 'Enter' && openRow(row)}>
        {#if isDocker}
          <span class="nm">{row.name}</span>
          <span class="col">{row.state}</span>
          <span class="col">{row.image}</span>
        {:else}
          <span class="nm">{cfg!.columns[0].cell(row)}</span>
          {#each cfg!.columns.slice(1) as col}<span class="col">{col.cell(row)}</span>{/each}
        {/if}
        {#if rowActions().length}
          <span class="iacts">
            {#each rowActions() as a}
              <button class="iact" title={a.title}
                onclick={(e) => { e.stopPropagation(); quickAction(row, a.actionId, a.deepLink); }}>{a.icon}</button>
            {/each}
          </span>
        {/if}
      </div>
    {/each}
  </div>
  {#if rowMsg}<p class="lp-empty">{rowMsg}</p>{/if}
{/if}

<Drawer bind:open={drawerOpen} bind:item={drawerItem} />
