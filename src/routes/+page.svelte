<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import RecentlyAdded from '$lib/components/widgets/RecentlyAdded.svelte';
  import NowPlaying from '$lib/components/widgets/NowPlaying.svelte';
  import WatchActivity from '$lib/components/widgets/WatchActivity.svelte';
  import Requests from '$lib/components/widgets/Requests.svelte';
  import DownloadQueue from '$lib/components/widgets/DownloadQueue.svelte';
  import Torrents from '$lib/components/widgets/Torrents.svelte';
  import Containers from '$lib/components/widgets/Containers.svelte';
  import ProxmoxHost from '$lib/components/widgets/ProxmoxHost.svelte';
  import WidgetBoundary from '$lib/components/WidgetBoundary.svelte';
  import WidgetFrame from '$lib/components/WidgetFrame.svelte';
  import Drawer from '$lib/components/Drawer.svelte';
  import type { DrawerItem } from '$lib/components/drawer-types';
  import {
    buildWidgetInstances,
    buildNiceDefaultLayout,
    mergeLayout,
    reconcileLayout,
    toSavedLayout,
    densityForWidth,
    minHForKind,
    maxHForKind,
    heightBoundsForKind,
    isFixedHeightKind,
    freeRectAt,
    snapToScale,
    GRID_COLUMNS,
    CELL_HEIGHT,
    GRID_MARGIN,
    type GridRect,
    type LayoutEntry
  } from '$lib/dashboard';
  // GridStack types only — the runtime is imported dynamically (browser-only) in onMount.
  import type { GridStack as GridStackType, GridStackNode } from 'gridstack';
  import { useMobile } from '$lib/media.svelte';
  import { _ } from 'svelte-i18n';

  let { data } = $props();

  // Reactive mobile breakpoint (≤768px). SSR-safe — starts false, wired up in onMount.
  const m = useMobile();
  const isMobile = $derived(m.isMobile);

  // PRESET cell grid: cellHeight IS the base "Small" height (~150px), so a widget's grid
  // height `h` is just its preset cell-count (Small=1, Medium=2, Large=3, XL=4). GridStack's
  // native resize-drag snaps to whole cells == exactly the presets. Margin stays consistent.
  const MARGIN = GRID_MARGIN;
  // Collapsed widgets shrink to the smallest cell (one base unit — the grid can't go below 1).
  const COLLAPSED_H = 1;

  // Build instances from connections, merge with the saved layout into the render list.
  const instances = $derived(buildWidgetInstances(data.connections ?? []));

  // Initialise ONCE from the server snapshot. `untrack` reads the current reactive values
  // without registering a subscription, signalling to Svelte 5 that this is a deliberate
  // one-time snapshot (suppresses state_referenced_locally lint). Subsequent changes to
  // `instances` are handled by the reconcile $effect below.
  let layout = $state<LayoutEntry[]>(
    untrack(() => mergeLayout(data.layout ?? [], buildWidgetInstances(data.connections ?? [])))
  );

  // Reconcile layout when `instances` changes (connection added/removed).
  // NEVER pulls from data.layout again — only syncs the KEY SET so in-session local changes
  // (hide/show/move/resize) are not clobbered. Guard: only assign when keys actually changed
  // (reconcileLayout returns the same reference when nothing differs) to prevent thrashing.
  $effect(() => {
    const next = reconcileLayout(layout, instances);
    if (next !== layout) layout = next;
  });

  // STABLE order — keyed by widget key, never reordered on drag. GridStack owns
  // visual position; reordering the Svelte array conflicts with GridStack's DOM.
  const visibleLayout = $derived(layout.filter((e) => e.visible));
  const hiddenLayout = $derived(layout.filter((e) => !e.visible));


  // --- Edit mode + drawer state ---
  let editing = $state(false);

  let drawerOpen = $state(false);
  let drawerItem = $state<DrawerItem | null>(null);
  function openDrawer(item: DrawerItem) {
    drawerItem = item;
    drawerOpen = true;
  }

  // --- GridStack instance ---
  let grid: GridStackType | null = $state(null);
  let gridEl = $state<HTMLElement | null>(null);
  // Suppress state-sync/persist while WE are mutating the grid (programmatic add/remove/update)
  // to avoid feedback loops.
  let suppressSave = false;
  // True between drag/resize START and STOP. While true we NEVER mutate the grid from a
  // geometry callback (it fires as the body resizes mid-interaction); we record it instead
  // and flush the bounds once the interaction ends.
  let interacting = false;
  // Keys whose native bounds need (re)applying once the current interaction settles.
  let pendingBounds = new Set<string>();

  // --- Persistence (debounced) ---
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await fetch('/api/layout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(toSavedLayout(layout))
        });
      } catch {
        /* best-effort; UI state is the source of truth this session */
      }
    }, 400);
  }

  function nodeKey(n: GridStackNode): string | undefined {
    return (n.id ?? n.el?.getAttribute('gs-id')) as string | undefined;
  }

  /** Read x/y/w/h back from GridStack nodes into our layout $state, then persist. */
  function syncFromGrid() {
    if (!grid || suppressSave) return;
    const byKey = new Map<string, GridStackNode>();
    for (const n of grid.engine.nodes) {
      const id = nodeKey(n);
      if (id) byKey.set(id, n);
    }
    layout = layout.map((e) => {
      const n = byKey.get(e.key);
      if (!n) return e;
      return {
        ...e,
        x: typeof n.x === 'number' ? n.x : e.x,
        y: typeof n.y === 'number' ? n.y : e.y,
        w: typeof n.w === 'number' ? n.w : e.w,
        // When collapsed we force a small h in the grid; keep the user's real height.
        h: e.collapsed ? e.h : typeof n.h === 'number' ? n.h : e.h
      };
    });
    persist();
  }

  function gridNode(key: string): GridStackNode | undefined {
    if (!grid) return undefined;
    return grid.engine.nodes.find((n) => nodeKey(n) === key);
  }

  // --- Svelte action: register/unregister each grid item with GridStack ---
  // makeWidget on mount; removeWidget(el, false) on destroy (false = keep DOM, Svelte owns it).
  // This makes hide/show (adding/removing {#each} items) register cleanly. While grid is null
  // (first paint, before onMount init), it's a no-op and init's DOM scan picks the item up.
  function gridItem(el: HTMLElement) {
    if (grid) {
      try {
        grid.makeWidget(el);
      } catch {
        /* grid may not be ready during a render race; init's DOM scan handles it */
      }
    }
    return {
      destroy() {
        if (grid) {
          try {
            grid.removeWidget(el, false);
          } catch {
            /* already gone */
          }
        }
      }
    };
  }

  onMount(async () => {
    if (data.connections.length === 0) return;
    const mod = await import('gridstack');
    await import('gridstack/dist/gridstack.min.css');
    const GridStack = mod.GridStack;
    if (!gridEl) return;

    grid = GridStack.init(
      {
        column: GRID_COLUMNS,
        cellHeight: CELL_HEIGHT,
        margin: MARGIN,
        float: true, // FREE placement — widgets stay exactly where dropped, no auto-reflow.
        handle: '.wf-drag',
        resizable: { handles: 'se, s, e' },
        // Keep resize handles visible in edit mode (not hover-only). More discoverable,
        // and avoids them auto-hiding after a drag/fit shifts the item out from the cursor.
        alwaysShowResizeHandle: true,
        // Start locked via staticGrid (NOT disableDrag/disableResize — those would persist
        // and defeat setStatic). The $effect below drives interactivity via setStatic().
        staticGrid: true
      },
      gridEl
    );

    // If we mount already at a mobile width, collapse to a single column immediately so
    // the first paint is the stacked layout (suppressing save — mobile layout is never
    // persisted; the desktop-authored 12-col layout remains the source of truth).
    if (isMobile) {
      suppressSave = true;
      try {
        grid.column(1, 'list');
      } catch {
        /* ignore */
      }
      suppressSave = false;
    }

    grid.on('change added removed', () => syncFromGrid());
    // CRITICAL: we MUST NOT mutate the grid mid-interaction (that crashed before). Mark
    // `interacting` on drag/resize START; any scale-bounds re-application is deferred via
    // pendingBounds and only applied once the interaction ends (flushPendingBounds).
    grid.on('resizestart dragstart', () => {
      interacting = true;
    });
    // Resize: snap height to the nearest CONTENT-ALIGNED valid height (exact N rows).
    // Defer the programmatic update to the next frame so GridStack finishes its own
    // resizestop bookkeeping (re-attaching the resize handles) before we mutate.
    grid.on('resizestop', (_e, el) => {
      const node = (el as { gridstackNode?: GridStackNode })?.gridstackNode;
      requestAnimationFrame(() => {
        interacting = false;
        if (node && grid) {
          suppressSave = true;
          try {
            snapAfterResize(node);
          } finally {
            suppressSave = false;
          }
        }
        syncFromGrid();
        flushPendingBounds();
      });
    });
    // Drag: grow into clearly-empty adjacent space so the layout stays tidy.
    // Deferred (next frame) for the same handle-reattach reason as resizestop.
    grid.on('dragstop', (_e, el) => {
      const node = (el as { gridstackNode?: GridStackNode })?.gridstackNode;
      requestAnimationFrame(() => {
        interacting = false;
        if (node && grid) {
          suppressSave = true;
          try {
            fitAfterDrag(node);
          } finally {
            suppressSave = false;
          }
        }
        syncFromGrid();
        flushPendingBounds();
      });
    });
  });

  onDestroy(() => {
    if (saveTimer) clearTimeout(saveTimer);
    if (grid) {
      grid.destroy(false);
      grid = null;
    }
  });

  // Responsive columns: collapse to a single vertical stack on mobile (≤768px), restore
  // the 12-column desktop layout when the viewport widens. GridStack caches the 12-col
  // layout internally so column(12) restores the exact authored positions. The mobile
  // 1-col layout is NEVER persisted (suppressSave) — the desktop layout stays canonical.
  // column(1, 'list') stacks items in their current visual order (y then x).
  let appliedMobileColumns = false;
  $effect(() => {
    const wantMobile = isMobile;
    if (!grid) return;
    const g = grid;
    if (wantMobile === appliedMobileColumns) return;
    appliedMobileColumns = wantMobile;
    // Leaving edit mode before collapsing avoids stale drag handles in the stacked view.
    if (wantMobile) editing = false;
    suppressSave = true;
    try {
      g.column(wantMobile ? 1 : GRID_COLUMNS, wantMobile ? 'list' : 'moveScale');
    } catch {
      /* ignore */
    }
    suppressSave = false;
  });

  // Toggle drag/resize when edit mode changes. setStatic(true) fully locks; setStatic(false)
  // enables BOTH move and resize — the reliable way to toggle interactivity in GridStack 12.
  // Await tick() so the `.wf-drag` handles (which only render in edit mode) exist in the DOM
  // BEFORE setStatic(false) re-inits drag&drop and scans for handles via getAllHandles().
  $effect(() => {
    const isEditing = editing;
    if (!grid) return;
    const g = grid;
    tick().then(() => {
      if (g) g.setStatic(!isEditing);
    });
  });

  // --- Modular height scale ----------------------------------------------------------
  // Every widget's height is a multiple of one base unit (Small/Medium/Large/XL), so
  // stacked widgets line up: two Smalls equal a Medium, a Small + a Medium equal a Large.
  // Heights snap STRICTLY to this scale on resizestop. Per-kind native minH/maxH (set via
  // gs-min-h/gs-max-h, applied OUTSIDE any drag) keep list widgets within Small..Large and
  // pin poster/carousel widgets to a single Medium block. fitRows still decides how many
  // rows render to fill the chosen preset; heights no longer come from measured content.

  /**
   * Re-apply a node's native scale bounds (minH/maxH) and snap its current height onto the
   * scale. Runs only OUTSIDE a live interaction (mount or after a settle) so the grid
   * mutation is safe; mid-interaction it's deferred via pendingBounds.
   */
  function applyScaleBounds(key: string) {
    if (!grid) return;
    if (interacting) {
      pendingBounds.add(key);
      return;
    }
    const entry = layout.find((e) => e.key === key);
    const node = gridNode(key);
    if (!entry || !node?.el || entry.collapsed) return;
    const { minH, maxH } = heightBoundsForKind(entry.kind);
    suppressSave = true;
    try {
      grid.update(node.el, { minH, maxH });
      if (typeof node.h === 'number') {
        const snapped = snapToScale(node.h, minH, maxH);
        if (snapped !== node.h) {
          grid.update(node.el, { h: snapped });
          layout = layout.map((e) => (e.key === key ? { ...e, h: snapped } : e));
        }
      }
    } catch {
      /* node may be gone */
    }
    suppressSave = false;
  }

  /** Re-apply scale bounds for any keys deferred during an interaction. */
  function flushPendingBounds() {
    if (pendingBounds.size === 0) return;
    const keys = [...pendingBounds];
    pendingBounds = new Set();
    for (const k of keys) applyScaleBounds(k);
  }

  // --- Mutations ---
  // Width and height are changed purely by DRAGGING the native GridStack resize handles
  // (e = width, s = height, se = both). Drag snaps to whole columns/cells == the presets;
  // there are no size buttons. resizestop persists + snaps height onto the scale.

  /** After a RESIZE, snap h STRICTLY to the modular scale within the kind's bounds. */
  function snapAfterResize(node: GridStackNode) {
    if (!grid) return;
    const key = nodeKey(node);
    if (!key || !node.el || typeof node.h !== 'number') return;
    const entry = layout.find((e) => e.key === key);
    if (entry?.collapsed) return; // collapsed h is managed separately
    const { minH, maxH } = entry
      ? heightBoundsForKind(entry.kind)
      : { minH: minHForKind(''), maxH: maxHForKind('') };
    const snapped = snapToScale(node.h, minH, maxH);
    if (snapped !== node.h) {
      try {
        grid.update(node.el, { h: snapped });
      } catch {
        /* node gone */
      }
    }
  }

  /**
   * After a DRAG settles, grow the widget to fill clearly-empty adjacent space so
   * the layout stays tidy. Width fills the free columns; height grows onto the largest
   * SCALE preset that still fits the free vertical span (capped at the kind's maxH).
   * Fixed-height kinds keep their height. Only EXPANDS — never shrinks, never overlaps.
   */
  function fitAfterDrag(node: GridStackNode) {
    if (!grid) return;
    const key = nodeKey(node);
    if (!key || !node.el) return;
    const entry = layout.find((e) => e.key === key);
    if (entry?.collapsed) return;
    if (typeof node.x !== 'number' || typeof node.y !== 'number') return;
    if (typeof node.w !== 'number' || typeof node.h !== 'number') return;

    const self: GridRect = { x: node.x, y: node.y, w: node.w, h: node.h };
    const others: GridRect[] = [];
    for (const n of grid.engine.nodes) {
      if (nodeKey(n) === key) continue;
      if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
      if (typeof n.w !== 'number' || typeof n.h !== 'number') continue;
      others.push({ x: n.x, y: n.y, w: n.w, h: n.h });
    }

    const { freeW, freeH } = freeRectAt(self, others, GRID_COLUMNS);

    // Target width: fill the free columns (clamped to the grid). Never below current.
    const targetW = Math.max(self.w, Math.min(freeW, GRID_COLUMNS));

    // Target height: grow onto the largest scale preset that fits the free vertical span,
    // capped at the kind's maxH. Fixed-height kinds keep their height (single block).
    let targetH = self.h;
    if (entry && !isFixedHeightKind(entry.kind)) {
      const { maxH } = heightBoundsForKind(entry.kind);
      const fitH = Math.min(freeH, maxH);
      const grown = snapToScale(fitH, self.h, maxH);
      // snapToScale rounds to nearest; ensure we never exceed the free span.
      targetH = grown <= fitH ? Math.max(self.h, grown) : self.h;
    }

    if (targetW !== self.w || targetH !== self.h) {
      try {
        grid.update(node.el, { w: targetW, h: targetH });
      } catch {
        /* node gone */
      }
    }
  }

  function toggleCollapse(key: string) {
    let nextCollapsed = false;
    let realH = 0;
    layout = layout.map((e) => {
      if (e.key !== key) return e;
      nextCollapsed = !e.collapsed;
      realH = e.h;
      return { ...e, collapsed: nextCollapsed };
    });
    const node = gridNode(key);
    if (grid && node?.el) {
      suppressSave = true;
      try {
        grid.update(node.el, { h: nextCollapsed ? COLLAPSED_H : realH });
      } catch {
        /* node gone */
      }
      suppressSave = false;
    }
    persist();
  }

  async function hide(key: string) {
    // Set suppressSave BEFORE the layout write so the GridStack `removed` event (fired when
    // gridItem.destroy() calls removeWidget after {#each} re-renders) does NOT trigger
    // syncFromGrid and overwrite the new visible:false state with a stale engine read.
    suppressSave = true;
    layout = layout.map((e) => (e.key === key ? { ...e, visible: false } : e));
    // Wait for Svelte to process the DOM removal and for GridStack events to settle.
    await tick();
    suppressSave = false;
    persist();
  }
  async function show(key: string) {
    // Suppress while the gridItem action's makeWidget fires `added`/`change` events — we
    // manage visible/x/y ourselves and don't want syncFromGrid to interfere.
    suppressSave = true;
    // Clear x/y so GridStack auto-places the widget into the first free spot instead of
    // restoring the stale saved position (which is often already occupied and causes overlap).
    layout = layout.map((e) =>
      e.key === key ? { ...e, x: undefined, y: undefined, visible: true } : e
    );
    await tick();
    // Read back the auto-placed position GridStack chose, then re-enable persistence.
    suppressSave = false;
    syncFromGrid();
    persist();
  }
  async function resetLayout() {
    // Build the "nice default" layout: curated x/y positions per kind so the result
    // is deliberately media-forward (NowPlaying + carousels in the wide left lane,
    // WatchActivity + Containers + Proxmox in the right sidebar, queues across the
    // bottom). Overflow widgets (no matching slot) get no x/y and auto-place below.
    const fresh = buildNiceDefaultLayout(instances);

    // Temporarily hide every widget so {#each} tears them all down (gridItem.destroy()
    // unregisters each from the GridStack engine). Without this, {#each} reuses the
    // existing DOM elements in-place and the gridItem action never re-runs, so newly
    // set x/y never take effect.
    layout = layout.map((e) => ({ ...e, visible: false }));
    await tick();

    // Restore with the designed layout (explicit x/y for curated slots).
    layout = fresh;

    // After Svelte re-renders the {#each} and GridStack picks up the new nodes,
    // compact() to close any gaps left by missing widgets (same mechanism Auto-align uses).
    // Deferred one frame so GridStack's own init of the newly-added nodes settles first.
    requestAnimationFrame(() => {
      if (grid && !interacting) {
        grid.compact();
        syncFromGrid();
      }
      persist();
    });
  }

  /**
   * Auto-align: compact all widgets up and left (removes gaps, preserves order).
   * Safe to call outside drag/resize — button click only, never mid-interaction.
   */
  function autoAlign() {
    if (!grid || interacting) return;
    // compact() packs items up/left, eliminating gaps. 'list' is the default strategy.
    grid.compact();
    // Read back new positions from GridStack engine into our layout $state, then persist.
    syncFromGrid();
  }

  // Build the gs-* attribute set for a grid item. Omitting gs-x/gs-y (undefined)
  // lets GridStack auto-place the widget. Native min/max height come from the kind's
  // modular-scale bounds — GridStack itself constrains the live resize, no mid-drag JS.
  function gsAttrs(entry: LayoutEntry): Record<string, string | number> {
    const { minH, maxH } = heightBoundsForKind(entry.kind);
    const itemMinH = entry.collapsed ? COLLAPSED_H : minH;
    const attrs: Record<string, string | number> = {
      'gs-id': entry.key,
      'gs-w': entry.w,
      'gs-h': entry.collapsed ? COLLAPSED_H : Math.min(Math.max(entry.h, minH), maxH),
      'gs-min-h': itemMinH,
      // Cap the live resize at the kind's largest preset (fixed-height kinds → min == max).
      'gs-max-h': Math.max(maxH, itemMinH)
    };
    if (typeof entry.x === 'number') attrs['gs-x'] = entry.x;
    if (typeof entry.y === 'number') attrs['gs-y'] = entry.y;
    return attrs;
  }
</script>

{#if data.connections.length === 0}
  <!-- ── First-run welcome ─────────────────────────────────────────────── -->
  <div class="welcome">
    <!-- Hero: EKG mark + title -->
    <div class="wlc-hero">
      <div class="wlc-mark">
        <svg class="ekg" viewBox="0 0 60 24" aria-hidden="true">
          <path d="M0,12 L12,12 L16,4 L20,20 L24,12 L36,12 L38,8 L40,16 L42,12 L60,12" />
        </svg>
      </div>
      <h1 class="wlc-title">{$_('onboarding.title')}</h1>
      <p class="wlc-sub">{$_('onboarding.subtitle')}</p>
      <a href="/settings" class="wlc-cta btn btn-p" data-testid="welcome-cta">
        {$_('onboarding.cta')}
      </a>
    </div>

    <!-- Integration hint row -->
    {#if data.integrations && data.integrations.length > 0}
      <div class="wlc-integrations">
        <p class="wlc-hint">{$_('onboarding.connectsWith')}</p>
        <div class="wlc-int-list">
          {#each data.integrations as integ}
            <a href="/settings" class="wlc-int-chip" title={$_('onboarding.addConnection', { values: { label: integ.label } })}>
              {integ.label}
            </a>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{:else}
  <!-- Layout editing is desktop-only: the Edit button (and edit mode) are hidden on
       mobile. The desktop-authored order drives the single-column mobile stack. -->
  <div class="dash-toolbar" class:dash-toolbar-hidden={isMobile}>
    {#if isMobile}
      <!-- no edit controls on mobile -->
    {:else if editing}
      <button type="button" class="tb-btn" onclick={resetLayout}>{$_('dashboard.resetLayout')}</button>
      <button type="button" class="tb-btn" onclick={autoAlign} title={$_('dashboard.autoAlignTitle')}>{$_('dashboard.autoAlign')}</button>
      <button type="button" class="tb-btn tb-done" onclick={() => (editing = false)}>{$_('dashboard.done')}</button>
    {:else}
      <button
        type="button"
        class="tb-btn"
        title={$_('dashboard.editLayout')}
        aria-label={$_('dashboard.editLayout')}
        onclick={() => (editing = true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span>{$_('dashboard.editLayout')}</span>
      </button>
    {/if}
  </div>

  {#if editing && hiddenLayout.length > 0}
    <div class="hidden-tray" role="region" aria-label="Hidden widgets">
      <span class="tray-label">{$_('dashboard.hiddenWidgets', { values: { count: hiddenLayout.length } })}</span>
      {#each hiddenLayout as e (e.key)}
        <button type="button" class="tray-chip" onclick={() => show(e.key)} title={$_('dashboard.showWidget', { values: { title: e.title } })}>
          {$_('dashboard.addWidget', { values: { title: e.title } })}
        </button>
      {/each}
    </div>
  {/if}

  <div class="dash-grid grid-stack" class:is-editing={editing} bind:this={gridEl}>
    {#each visibleLayout as entry (entry.key)}
      <div class="grid-stack-item" {...gsAttrs(entry)} use:gridItem>
        <div class="grid-stack-item-content">
          <WidgetBoundary>
            <WidgetFrame
              instance={entry}
              {editing}
              onToggleCollapse={toggleCollapse}
              onHide={hide}
            >
              {#if entry.kind === 'nowplaying'}
                <NowPlaying size={densityForWidth(entry.w)} collapsed={entry.collapsed} />
              {:else if entry.kind === 'watch'}
                <WatchActivity size={densityForWidth(entry.w)} collapsed={entry.collapsed} />
              {:else if entry.kind === 'containers'}
                <Containers size={densityForWidth(entry.w)} collapsed={entry.collapsed} onItemClick={openDrawer} />
              {:else if entry.kind === 'recentlyadded'}
                <RecentlyAdded connectionId={entry.connectionId!} size={densityForWidth(entry.w)} collapsed={entry.collapsed} onItemClick={openDrawer} />
              {:else if entry.kind === 'requests'}
                <Requests connectionId={entry.connectionId!} size={densityForWidth(entry.w)} collapsed={entry.collapsed} onItemClick={openDrawer} />
              {:else if entry.kind === 'downloadqueue'}
                <DownloadQueue connectionId={entry.connectionId!} label={entry.label ?? ''} size={densityForWidth(entry.w)} collapsed={entry.collapsed} onItemClick={openDrawer} />
              {:else if entry.kind === 'torrents'}
                <Torrents connectionId={entry.connectionId!} size={densityForWidth(entry.w)} collapsed={entry.collapsed} onItemClick={openDrawer} />
              {:else if entry.kind === 'proxmoxhost'}
                <ProxmoxHost connectionId={entry.connectionId!} size={densityForWidth(entry.w)} collapsed={entry.collapsed} />
              {/if}
            </WidgetFrame>
          </WidgetBoundary>
        </div>
      </div>
    {/each}
  </div>
{/if}

<Drawer bind:open={drawerOpen} bind:item={drawerItem} />

<style>
  .dash-toolbar {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-bottom: 16px;
  }
  .dash-toolbar-hidden {
    display: none;
  }
  .tb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--card);
    border: 1px solid var(--card-brd);
    border-radius: 9px;
    color: var(--sub);
    cursor: pointer;
    font-size: 13px;
    font-weight: 600;
    padding: 7px 12px;
    transition: color 0.15s, border-color 0.15s;
  }
  .tb-btn:hover { color: var(--txt); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .tb-btn svg { width: 15px; height: 15px; }
  .tb-done {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #08110d;
    border-color: transparent;
  }
  .tb-done:hover { color: #08110d; }

  .hidden-tray {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 16px;
    padding: 12px 16px;
    /* Accent-tinted background so the tray stands out clearly against the page */
    background: color-mix(in srgb, var(--accent) 8%, var(--card));
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
    border-radius: var(--radius);
    /* Subtle left accent stripe to make the panel unmistakable */
    border-left: 3px solid var(--accent);
  }
  .tray-label {
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    /* Use --txt instead of --sub so the label is clearly readable */
    color: var(--txt);
    margin-right: 4px;
    flex-shrink: 0;
  }
  .tray-chip {
    background: color-mix(in srgb, var(--accent) 12%, var(--card));
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    border-radius: 99px;
    color: var(--txt);
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    padding: 5px 12px;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .tray-chip:hover {
    background: color-mix(in srgb, var(--accent) 22%, var(--card));
    border-color: var(--accent);
    color: var(--accent);
  }

  /* GridStack free-placement grid. GridStack absolutely-positions items via transforms.
     The .grid-stack-item-content is the cell surface; the WidgetFrame fills it and the
     widget content fills the frame body (no scrollbars — fit-to-height handles overflow). */
  .dash-grid.grid-stack {
    min-height: 88px;
  }

  /* The item-content fills the grid cell exactly; clip anything that exceeds it. */
  .dash-grid :global(.grid-stack-item-content) {
    inset: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Tighten the per-widget chrome INSIDE the dashboard grid (scoped — the global
     .card padding stays larger elsewhere). Less fixed overhead = more of each cell
     is usable list body, so small heights aren't dead space and rows fill cleanly. */
  .dash-grid :global(.wf-body .card) {
    padding: 12px 14px;
  }
  .dash-grid :global(.wf-body .card h3) {
    margin-bottom: 8px;
  }
  .dash-grid :global(.wf-body .card .ch) {
    margin-bottom: 8px;
  }

  /* FIX 1 — edit-mode title overlap: in edit mode the opaque .wf-edit-bar overlay shows
     the frame's title, so HIDE each widget's OWN header (the .ch wrapper or a bare h3 that
     is a direct child of .card). visibility:hidden (NOT display:none) keeps the header's
     layout space, so the content height is IDENTICAL in edit vs view — no content shift —
     and the overlay sits cleanly where the title was. One clean title per widget. */
  .dash-grid.is-editing :global(.wf-body .card > .ch),
  .dash-grid.is-editing :global(.wf-body .card > h3) {
    visibility: hidden;
  }

  /* Resize handles only show in edit mode (init starts static; setStatic toggles it,
     but also belt-and-suspenders hide the visual handles when not editing). */
  .dash-grid:not(.is-editing) :global(.ui-resizable-handle) {
    display: none !important;
  }

  /*
   * Hide the resize-handle ICON (the diagonal double-arrow glyph GridStack paints in the
   * bottom-right corner) while keeping the handle element fully functional (hit-testable,
   * cursor still reflects resize direction). We do NOT touch display/pointer-events — only
   * the decorative glyph is removed. GridStack injects the arrow via background-image on
   * .ui-resizable-se and via ::after content on some builds; zero out both.
   */
  .dash-grid :global(.ui-resizable-se),
  .dash-grid :global(.ui-resizable-s),
  .dash-grid :global(.ui-resizable-e) {
    background-image: none !important;
  }
  .dash-grid :global(.ui-resizable-se::after),
  .dash-grid :global(.ui-resizable-s::after),
  .dash-grid :global(.ui-resizable-e::after),
  .dash-grid :global(.ui-resizable-se::before),
  .dash-grid :global(.ui-resizable-s::before),
  .dash-grid :global(.ui-resizable-e::before) {
    content: none !important;
    display: none !important;
  }

  /* While dragging, GridStack applies ~0.8 opacity to the dragged item; override it
     so the tile renders fully opaque and the widget beneath doesn't bleed through. */
  .dash-grid :global(.grid-stack-item.ui-draggable-dragging) {
    opacity: 1 !important;
  }
  .dash-grid :global(.grid-stack-item.ui-draggable-dragging .grid-stack-item-content) {
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55), 0 0 0 2px var(--accent);
  }

  /* ── First-run welcome ──────────────────────────────────────────────── */
  .welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 40px;
    min-height: 62vh;
    padding: 56px 24px 40px;
  }

  .wlc-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    max-width: 480px;
    text-align: center;
  }

  /* EKG mark — slightly larger than the topbar version */
  .wlc-mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    border-radius: 20px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    box-shadow: 0 8px 28px color-mix(in srgb, var(--accent) 38%, transparent);
    flex-shrink: 0;
  }

  .wlc-mark .ekg {
    width: 48px;
    height: 18px;
    opacity: 0.9;
  }

  .wlc-mark .ekg path {
    stroke: #08110d;
    stroke-width: 2.2;
    fill: none;
    stroke-dasharray: 120;
    stroke-dashoffset: 120;
    animation: trace 2.4s linear infinite;
  }

  .wlc-title {
    font-size: 28px;
    font-weight: 800;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--txt) 40%, color-mix(in srgb, var(--accent) 60%, var(--txt)));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }

  .wlc-sub {
    font-size: 15px;
    color: var(--sub);
    line-height: 1.6;
    max-width: 380px;
  }

  .wlc-cta {
    display: inline-block;
    margin-top: 4px;
    padding: 13px 28px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 700;
    text-decoration: none;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #08110d;
    box-shadow: 0 4px 18px color-mix(in srgb, var(--accent) 40%, transparent);
    transition: opacity 0.15s, transform 0.15s, box-shadow 0.15s;
  }

  .wlc-cta:hover {
    opacity: 0.92;
    transform: translateY(-2px);
    box-shadow: 0 8px 24px color-mix(in srgb, var(--accent) 50%, transparent);
  }

  /* Integration hint */
  .wlc-integrations {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }

  .wlc-hint {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--sub);
    opacity: 0.7;
  }

  .wlc-int-list {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
  }

  .wlc-int-chip {
    font-size: 12px;
    font-weight: 600;
    padding: 5px 13px;
    border-radius: 99px;
    border: 1px solid var(--card-brd);
    background: var(--card);
    color: var(--sub);
    text-decoration: none;
    backdrop-filter: blur(8px);
    transition: color 0.15s, border-color 0.15s, background 0.15s;
  }

  .wlc-int-chip:hover {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, var(--card));
  }

  /* Mobile welcome */
  @media (max-width: 768px) {
    .welcome { padding: 40px 16px 32px; gap: 28px; }
    .wlc-title { font-size: 22px; }
    .wlc-sub { font-size: 14px; }
  }

  /* Legacy btn classes — kept for any stray usages */
  .btn {
    padding: 11px 22px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    border: none;
    text-decoration: none;
    display: inline-block;
  }
  .btn-p {
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    color: #08110d;
  }
</style>
