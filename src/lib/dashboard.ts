// Dashboard widget registry, sizing model, and saved-layout merge.
// Pure functions only — safe to import on both server and client.
//
// Layout model: GridStack FREE-placement grid (float:true). Each widget has grid
// coords { x, y, w, h } on a 12-column grid (w/h in grid units; x/y = exact cell).
// Content density is derived from `w` (width in columns) via densityForWidth().

export type WidgetSize = 's' | 'm' | 'l' | 'full';

export const WIDGET_SIZES: WidgetSize[] = ['s', 'm', 'l', 'full'];

/** The 12-column grid width. */
export const GRID_COLUMNS = 12;

/**
 * GridStack geometry (must match +page.svelte init). ONE vertical cell == the base
 * "Small" height: `cellHeight` IS the base height unit (~150px). So a widget's grid
 * height `h` is just its preset cell-count — Small=1, Medium=2, Large=3, XL=4 — and
 * GridStack's NATIVE resize-drag snaps to whole cells == exactly the presets, with no
 * custom mid-drag JS. The vertical margin between cells is `GRID_MARGIN`.
 *
 * GridStack sizes each item's outer box at `cellHeight*h` and applies `margin` as the
 * item's inset (top+bottom). So the USABLE content box of a widget spanning `h` cells is:
 *   pxForH(h) = cellHeight*h - 2*margin
 * Because every cell is a whole base unit, stacked widgets align exactly: two Small
 * (1+1) cells equal one Medium (2) cell, etc.
 */
export const CELL_HEIGHT = 150;
export const GRID_MARGIN = 10;

/** Usable content pixel height of a widget spanning `h` grid rows (cell box minus margins). */
export function pxForH(h: number, cell = CELL_HEIGHT, margin = GRID_MARGIN): number {
  return cell * h - 2 * margin;
}

// --- Modular height scale ----------------------------------------------------------
//
// Every widget's height is a whole number of base cells, so heights line up when
// widgets are stacked: two Smalls equal one Medium, a Small + a Medium equal a Large.
// GridStack stacks whole cells to equal totals, so adjacent columns' tops/bottoms align
// perfectly. NATIVE resize-drag snaps STRICTLY to whole cells == the presets — there is
// no in-between height and no custom mid-drag code (which is what avoids the crash).

/** The base grid-`h` unit (one cell). Small = BASE_H; every preset is a small integer. */
export const BASE_H = 1;

/** The named height presets, each an exact multiple of BASE_H so they compose & align. */
export type HeightScale = 'small' | 'medium' | 'large' | 'xl';
export const HEIGHT_SCALE: Record<HeightScale, number> = {
  small: BASE_H, // 1 cell  (~150px)
  medium: 2 * BASE_H, // 2 cells (= Small + Small)
  large: 3 * BASE_H, // 3 cells (= Small + Medium)
  xl: 4 * BASE_H // 4 cells (= Medium + Medium)
};
/** The scale heights in ascending order — the ONLY heights a widget may settle on. */
export const SCALE_HEIGHTS: number[] = [
  HEIGHT_SCALE.small,
  HEIGHT_SCALE.medium,
  HEIGHT_SCALE.large,
  HEIGHT_SCALE.xl
];

/**
 * Snap an arbitrary grid height to the nearest scale height within [minH, maxH].
 * On a tie prefer the LARGER preset so a widget never under-fills its content.
 */
export function snapToScale(h: number, minH = BASE_H, maxH = HEIGHT_SCALE.xl): number {
  const lo = Math.min(minH, maxH);
  const hi = Math.max(minH, maxH);
  const candidates = SCALE_HEIGHTS.filter((v) => v >= lo && v <= hi);
  if (candidates.length === 0) return Math.min(Math.max(Math.round(h), lo), hi);
  let best = candidates[0];
  let bestDist = Math.abs(h - best);
  for (const v of candidates) {
    const d = Math.abs(h - v);
    if (d < bestDist || (d === bestDist && v > best)) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Per-kind native height bounds in whole base cells. Both bounds are scale multiples
 * so min/max themselves align with neighbours. Applied to GridStack as gs-min-h/gs-max-h
 * so the NATIVE resize-drag is constrained to these presets — no mid-drag JS.
 *  - List widgets:  Small(1)..XL(4) — content fills via fitRows (a little empty space
 *    at the bottom of a preset is acceptable; alignment matters more than an exact fit).
 *    XL == two Mediums stacked, useful for tall lists.
 *  - Poster/carousel (recentlyadded, requests): a single poster strip — fixed at Medium(2)
 *    (min = max) so they're not height-resizable and sit as a clean Medium block.
 *  - ProxmoxHost: its CPU/RAM/Disk block fits Medium — Small(1)..Medium(2) so it can't be
 *    dragged shorter than its content.
 */
export interface HeightBounds {
  minH: number;
  maxH: number;
}
const KIND_HEIGHT_BOUNDS: Record<string, HeightBounds> = {
  recentlyadded: { minH: HEIGHT_SCALE.medium, maxH: HEIGHT_SCALE.medium },
  requests: { minH: HEIGHT_SCALE.medium, maxH: HEIGHT_SCALE.medium },
  proxmoxhost: { minH: HEIGHT_SCALE.small, maxH: HEIGHT_SCALE.medium }
  // 'watch' falls through to DEFAULT_HEIGHT_BOUNDS (Small..XL), same as other list widgets.
};
/** Default bounds for list widgets (and any kind not specially listed).
 *  maxH raised to XL (4 cells = two Mediums stacked) so list widgets can be sized taller. */
const DEFAULT_HEIGHT_BOUNDS: HeightBounds = {
  minH: HEIGHT_SCALE.small,
  maxH: HEIGHT_SCALE.xl
};

/** The native min/max grid height (on the scale) for a widget kind. */
export function heightBoundsForKind(kind: string): HeightBounds {
  return KIND_HEIGHT_BOUNDS[kind] ?? DEFAULT_HEIGHT_BOUNDS;
}

/** Whether a kind's height is fixed (not resizable): poster/carousel strips. */
export function isFixedHeightKind(kind: string): boolean {
  const b = heightBoundsForKind(kind);
  return b.minH === b.maxH;
}

/**
 * Map a widget's width-in-columns to a content-density bucket.
 * Wider widgets show more items. Reused by capForSize/colsForSize so content
 * reflows as the user resizes width.
 */
export function densityForWidth(w: number): WidgetSize {
  if (w <= 3) return 's';
  if (w <= 5) return 'm';
  if (w <= 8) return 'l';
  return 'full';
}

/** Width presets (columns) — the per-kind default widths a fresh widget gets. */
export const SIZE_PRESETS: Record<WidgetSize, { w: number }> = {
  s: { w: 3 },
  m: { w: 4 },
  l: { w: 6 },
  full: { w: 12 }
};

/** Native minimum grid height (on the modular scale) for a kind. */
export function minHForKind(kind: string): number {
  return heightBoundsForKind(kind).minH;
}

/** Native maximum grid height (on the modular scale) for a kind. */
export function maxHForKind(kind: string): number {
  return heightBoundsForKind(kind).maxH;
}

/** A minimal connection shape — matches the secret-free objects from +layout.server.ts. */
export interface DashConnection {
  id: number;
  type: string;
  name: string;
  enabled: boolean;
}

/** Default grid footprint for a widget kind. */
interface DefaultBox {
  w: number;
  h: number;
}

/** A widget instance is a concrete widget to render (a global, or one bound to a connection). */
export interface WidgetInstance {
  key: string;
  kind: string;
  title: string;
  connectionId?: number;
  label?: string;
  /** Default grid footprint (used on first placement). */
  defaultW: number;
  defaultH: number;
}

/** A saved/merged layout entry: instance metadata plus the user's per-widget layout state. */
export interface LayoutEntry extends WidgetInstance {
  /** Grid X position (column), or undefined to let GridStack auto-place. */
  x?: number;
  /** Grid Y position (row), or undefined to let GridStack auto-place. */
  y?: number;
  w: number;
  h: number;
  visible: boolean;
  collapsed: boolean;
}

/** The persisted layout shape (the subset we store in settings). */
export interface SavedLayoutEntry {
  key: string;
  x?: number;
  y?: number;
  w: number;
  h: number;
  visible: boolean;
  collapsed: boolean;
}

/**
 * Default grid footprints per widget kind. Heights are SCALE presets (Small/Medium/Large)
 * so a fresh dashboard is composed of aligned modular blocks. Each default is clamped to
 * the kind's height bounds so it's always a valid, resizable preset.
 */
interface DefaultBoxScale {
  w: number;
  /** Default height as a scale preset. */
  h: number;
}
const DEFAULT_BOXES: Record<string, DefaultBoxScale> = {
  // Media hub: NowPlaying spans 8 cols — prominent at the top.
  nowplaying: { w: 8, h: HEIGHT_SCALE.medium },
  // Carousel/poster widgets fill the wide left column (fixed at Medium by height bounds).
  recentlyadded: { w: 8, h: HEIGHT_SCALE.medium },
  requests: { w: 8, h: HEIGHT_SCALE.medium },
  // Watch activity is a tall list on the right sidebar (Large = 3 cells).
  watch: { w: 4, h: HEIGHT_SCALE.large },
  // Containers + ProxmoxHost fill the right sidebar as Medium blocks.
  containers: { w: 4, h: HEIGHT_SCALE.medium },
  proxmoxhost: { w: 4, h: HEIGHT_SCALE.medium },
  // Download queues and torrents are compact single-row list panels.
  downloadqueue: { w: 4, h: HEIGHT_SCALE.medium },
  torrents: { w: 4, h: HEIGHT_SCALE.medium }
};

function boxFor(kind: string): DefaultBox {
  const b = DEFAULT_BOXES[kind] ?? { w: 4, h: HEIGHT_SCALE.medium };
  const { minH, maxH } = heightBoundsForKind(kind);
  return { w: b.w, h: Math.min(Math.max(b.h, minH), maxH) };
}

/**
 * Build the ordered list of widget instances available for the given connections.
 * Globals come first, then per-connection widgets grouped by connection order.
 */
export function buildWidgetInstances(connections: DashConnection[]): WidgetInstance[] {
  const enabled = (connections ?? []).filter((c) => c.enabled);

  function make(partial: Omit<WidgetInstance, 'defaultW' | 'defaultH'>): WidgetInstance {
    const box = boxFor(partial.kind);
    return { ...partial, defaultW: box.w, defaultH: box.h };
  }

  // Show the combined Watch Activity widget when any watch-history source exists.
  // Sources: tautulli (plex stats), jellystat (jellyfin stats), or jellyfin (recently watched).
  const hasWatchSource = enabled.some(
    (c) => c.type === 'tautulli' || c.type === 'jellystat' || c.type === 'jellyfin'
  );

  const instances: WidgetInstance[] = [
    make({ key: 'nowplaying', kind: 'nowplaying', title: 'Now Playing' }),
    ...(hasWatchSource
      ? [make({ key: 'watch', kind: 'watch', title: 'Watch Activity' })]
      : []),
    make({ key: 'containers', kind: 'containers', title: 'Containers' })
  ];

  for (const c of enabled) {
    switch (c.type) {
      case 'jellyfin':
        instances.push(
          make({
            key: `recentlyadded:${c.id}`,
            kind: 'recentlyadded',
            connectionId: c.id,
            title: `${c.name} — Recently Added`
          })
        );
        break;
      case 'seerr':
        instances.push(
          make({
            key: `requests:${c.id}`,
            kind: 'requests',
            connectionId: c.id,
            title: `${c.name} — Requests`
          })
        );
        break;
      case 'radarr':
        instances.push(
          make({
            key: `queue:${c.id}`,
            kind: 'downloadqueue',
            connectionId: c.id,
            label: 'Radarr',
            title: `${c.name} — Radarr Queue`
          })
        );
        break;
      case 'sonarr':
        instances.push(
          make({
            key: `queue:${c.id}`,
            kind: 'downloadqueue',
            connectionId: c.id,
            label: 'Sonarr',
            title: `${c.name} — Sonarr Queue`
          })
        );
        break;
      case 'qbittorrent':
        instances.push(
          make({
            key: `torrents:${c.id}`,
            kind: 'torrents',
            connectionId: c.id,
            title: `${c.name} — Torrents`
          })
        );
        break;
      case 'jellystat':
        // Most Watched is now a global widget (aggregates Tautulli + Jellystat).
        // No per-jellystat instance is created here.
        break;
      case 'proxmox':
        instances.push(
          make({
            key: `proxmoxhost:${c.id}`,
            kind: 'proxmoxhost',
            connectionId: c.id,
            title: `${c.name} — Proxmox`
          })
        );
        break;
      default:
        break;
    }
  }

  return instances;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Merge a saved layout with the current instances into the render list.
 * Existing saved keys keep their { x, y, w, h, visible, collapsed }. New
 * instances are appended visible with NO x/y (GridStack auto-places them) and
 * their default w/h. Saved entries whose instance no longer exists are dropped.
 *
 * Order follows the INSTANCES order (stable, keyed) — never the saved order —
 * because GridStack owns visual position; the {#each} order must not reorder on drag.
 */
/** The geometry of the OLD fine grid (cellHeight 6, margin 10) — used only to migrate
 *  legacy saved heights (which were counts of 6px cells) onto the new preset cell grid. */
const LEGACY_CELL = 6;
const LEGACY_MARGIN = 10;

/**
 * Convert a saved height to the new preset-cell scale. Legacy layouts stored `h` as a
 * count of 6px cells (Small≈25, Medium≈50, Large≈75); any value above XL (4) must be a
 * legacy height, so map it through its pixel equivalent to the nearest new cell-count.
 * Values already in 1..4 are treated as new-scale heights and pass through unchanged.
 */
function migrateSavedH(h: number): number {
  if (h <= HEIGHT_SCALE.xl) return h; // already a new-scale cell-count
  const px = LEGACY_CELL * h - 2 * LEGACY_MARGIN; // old usable content px
  return Math.max(1, Math.round((px + 2 * GRID_MARGIN) / CELL_HEIGHT));
}

export function mergeLayout(
  saved: SavedLayoutEntry[] | null | undefined,
  instances: WidgetInstance[]
): LayoutEntry[] {
  const savedByKey = new Map<string, SavedLayoutEntry>();
  for (const s of saved ?? []) {
    if (s && typeof s.key === 'string' && !savedByKey.has(s.key)) {
      savedByKey.set(s.key, s);
    }
  }

  const merged: LayoutEntry[] = [];
  for (const inst of instances) {
    const { minH, maxH } = heightBoundsForKind(inst.kind);
    const s = savedByKey.get(inst.key);
    if (s) {
      const w = num(s.w) ?? inst.defaultW;
      const rawH = num(s.h) ?? inst.defaultH;
      const h = migrateSavedH(rawH);
      const collapsed = s.collapsed === true;
      merged.push({
        ...inst,
        x: num(s.x),
        y: num(s.y),
        w: Math.min(Math.max(w, 1), GRID_COLUMNS),
        // Snap a persisted height onto the modular scale within the kind's bounds ONCE here
        // (init-time), so an old per-pixel layout migrates to a clean aligned preset and a
        // fixed-height kind collapses to its single block. Collapsed widgets keep their
        // (migrated) real height (the grid forces a small collapsed h at runtime).
        h: collapsed ? Math.max(h, 1) : snapToScale(h, minH, maxH),
        visible: s.visible !== false,
        collapsed
      });
    } else {
      // New instance: auto-place (no x/y) with default footprint, snapped to the scale.
      merged.push({
        ...inst,
        x: undefined,
        y: undefined,
        w: inst.defaultW,
        h: snapToScale(inst.defaultH, minH, maxH),
        visible: true,
        collapsed: false
      });
    }
  }

  return merged;
}

/**
 * Build the "nice default" layout — a deliberately media-forward arrangement that
 * Reset layout and a fresh dashboard should both produce.
 *
 * Layout design (12-column grid, heights are modular-scale cells):
 *   x=0..7 (w=8): NowPlaying | RecentlyAdded | Requests    ← wide left "media" lane
 *   x=8..11 (w=4): WatchActivity (tall) | Containers | ProxmoxHost ← right sidebar
 *   x=0..11 (w=4 each): DownloadQueues + Torrents          ← compact bottom row
 *
 * Only the FIRST instance of each "slot" kind gets an explicit x/y.  Overflow instances
 * (e.g. a second Jellyfin connection) get no x/y so GridStack auto-places them below.
 * Widgets from kinds not in this table also auto-place (safe for future kinds).
 *
 * The caller should run grid.compact() after applying this layout so any gaps left by
 * missing widgets close up — the same mechanism Auto-align uses.
 */
export function buildNiceDefaultLayout(instances: WidgetInstance[]): LayoutEntry[] {
  // Curated slot table: each entry is tried in order.  The first instance of the
  // matching kind claims the slot; the slot is then marked used.
  type Slot = { kind: string; x: number; y: number; w: number; h: number };
  const slots: Slot[] = [
    // --- Left/wide media column ---
    { kind: 'nowplaying',    x: 0, y: 0, w: 8, h: HEIGHT_SCALE.medium }, // row 0-1
    { kind: 'recentlyadded', x: 0, y: 2, w: 8, h: HEIGHT_SCALE.medium }, // row 2-3
    { kind: 'requests',      x: 0, y: 4, w: 8, h: HEIGHT_SCALE.medium }, // row 4-5

    // --- Right sidebar ---
    { kind: 'watch',         x: 8, y: 0, w: 4, h: HEIGHT_SCALE.large  }, // row 0-2 (3 tall)
    { kind: 'containers',    x: 8, y: 3, w: 4, h: HEIGHT_SCALE.medium }, // row 3-4
    { kind: 'proxmoxhost',   x: 8, y: 5, w: 4, h: HEIGHT_SCALE.medium }, // row 5-6

    // --- Compact bottom band (queues + torrents, w=4 each) ---
    { kind: 'downloadqueue', x: 0, y: 6, w: 4, h: HEIGHT_SCALE.medium }, // radarr or first queue
    { kind: 'downloadqueue', x: 4, y: 6, w: 4, h: HEIGHT_SCALE.medium }, // sonarr or second queue
    { kind: 'torrents',      x: 8, y: 7, w: 4, h: HEIGHT_SCALE.medium }, // below proxmox
  ];

  // Track which slots have been filled (by index).
  const usedSlots = new Set<number>();

  const entries: LayoutEntry[] = instances.map((inst) => {
    const { minH, maxH } = heightBoundsForKind(inst.kind);

    // Find the first unused slot matching this kind.
    const slotIdx = slots.findIndex((s, i) => s.kind === inst.kind && !usedSlots.has(i));
    if (slotIdx >= 0) {
      usedSlots.add(slotIdx);
      const s = slots[slotIdx];
      const h = Math.min(Math.max(snapToScale(s.h, minH, maxH), minH), maxH);
      return {
        ...inst,
        x: s.x,
        y: s.y,
        w: Math.min(s.w, GRID_COLUMNS),
        h,
        visible: true,
        collapsed: false
      };
    }

    // No slot matched — auto-place (no x/y) with default footprint.
    return {
      ...inst,
      x: undefined,
      y: undefined,
      w: inst.defaultW,
      h: snapToScale(inst.defaultH, minH, maxH),
      visible: true,
      collapsed: false
    };
  });

  return entries;
}

/** A placed grid rectangle (the bits of a node the free-rect math needs). */
export interface GridRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Compute the free rectangle anchored at a widget's top-left (x, y), given the
 * OTHER occupied rectangles on the grid. Used by "suggest-fit on drag": grow the
 * dragged widget into clearly-empty adjacent space (right + down) so the layout
 * stays tidy.
 *
 *  - `freeW` = how many columns are free to the right starting at x, until another
 *    widget's left edge blocks the row at y, capped at the 12-col edge.
 *  - `freeH` = how many rows are free downward across those `freeW` columns until
 *    another widget blocks any of them.
 *
 * Only considers `others` that actually overlap the relevant span — so it expands
 * into empty space and never overlaps a neighbour. Never returns less than the
 * widget's own current (w, h): the caller only ever EXPANDS, never shrinks.
 */
export function freeRectAt(
  self: GridRect,
  others: GridRect[],
  columns: number = GRID_COLUMNS
): { freeW: number; freeH: number } {
  const x = Math.max(0, self.x);
  const y = Math.max(0, self.y);

  // --- freeW: scan right along row `y` (the widget's top row) for the first blocker.
  // A blocker is a node that covers row y and whose left edge is at/after x.
  let freeW = columns - x;
  for (const o of others) {
    const coversRow = o.y <= y && o.y + o.h > y;
    if (!coversRow) continue;
    if (o.x >= x && o.x - x < freeW) {
      freeW = o.x - x;
    }
  }
  freeW = Math.max(self.w, freeW); // never shrink below current width

  // --- freeH: scan down across columns [x, x+freeW) for the first blocker row.
  let freeH = Infinity;
  for (const o of others) {
    const overlapsCols = o.x < x + freeW && o.x + o.w > x;
    if (!overlapsCols) continue;
    if (o.y >= y) {
      const gap = o.y - y;
      if (gap < freeH) freeH = gap;
    }
  }
  if (!Number.isFinite(freeH)) freeH = self.h; // nothing below → keep own height as floor
  freeH = Math.max(self.h, freeH); // never shrink below current height

  return { freeW, freeH };
}

/** Reduce a merged layout to just the persistable fields. */
export function toSavedLayout(layout: LayoutEntry[]): SavedLayoutEntry[] {
  return layout.map(({ key, x, y, w, h, visible, collapsed }) => ({
    key,
    x,
    y,
    w,
    h,
    visible,
    collapsed
  }));
}

/**
 * Reconcile the CURRENT in-memory layout against a fresh set of instances.
 *
 * Rules:
 *  - Keep every entry whose instance still exists, preserving its `visible`,
 *    `collapsed`, `x`, `y`, `w`, `h`, `rows` exactly — do NOT reset them.
 *  - Append any NEW instance (one not already in `current`) with its default box
 *    (visible, no x/y so GridStack auto-places it).
 *  - Drop entries whose instance no longer exists.
 *
 * Does NOT read from a saved server layout — it only reconciles `current` with
 * the new instance set, so in-session hide/show/move/resize edits are preserved.
 *
 * Returns the same array reference when nothing changed (keys and order identical),
 * so callers can use a reference-equality check to suppress redundant $effect writes.
 */
export function reconcileLayout(
  current: LayoutEntry[],
  instances: WidgetInstance[]
): LayoutEntry[] {
  const instanceKeys = new Set(instances.map((i) => i.key));
  const currentByKey = new Map<string, LayoutEntry>(current.map((e) => [e.key, e]));

  // Check whether a new array is actually needed.
  // It's needed if: any current key is missing from instances, OR any instance key
  // is missing from current (a new connection was added).
  const hasDrop = current.some((e) => !instanceKeys.has(e.key));
  const hasNew = instances.some((i) => !currentByKey.has(i.key));

  if (!hasDrop && !hasNew) {
    // Key sets are identical — nothing to add or remove. Return same reference.
    return current;
  }

  const reconciled: LayoutEntry[] = [];
  for (const inst of instances) {
    const existing = currentByKey.get(inst.key);
    if (existing) {
      // Preserve all local state exactly.
      reconciled.push(existing);
    } else {
      // New instance: auto-place (no x/y), default footprint, snapped to scale.
      const { minH, maxH } = heightBoundsForKind(inst.kind);
      reconciled.push({
        ...inst,
        x: undefined,
        y: undefined,
        w: inst.defaultW,
        h: snapToScale(inst.defaultH, minH, maxH),
        visible: true,
        collapsed: false
      });
    }
  }
  return reconciled;
}
