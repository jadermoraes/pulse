import { describe, it, expect } from 'vitest';
import {
  buildWidgetInstances,
  mergeLayout,
  reconcileLayout,
  toSavedLayout,
  densityForWidth,
  minHForKind,
  maxHForKind,
  heightBoundsForKind,
  isFixedHeightKind,
  freeRectAt,
  SIZE_PRESETS,
  GRID_COLUMNS,
  CELL_HEIGHT,
  GRID_MARGIN,
  pxForH,
  BASE_H,
  HEIGHT_SCALE,
  SCALE_HEIGHTS,
  snapToScale,
  type DashConnection,
  type GridRect,
  type LayoutEntry,
  type SavedLayoutEntry,
  type WidgetInstance
} from './dashboard';

const conns: DashConnection[] = [
  { id: 1, type: 'jellyfin', name: 'JF', enabled: true },
  { id: 2, type: 'seerr', name: 'Overseerr', enabled: true },
  { id: 3, type: 'radarr', name: 'Radarr', enabled: true },
  { id: 4, type: 'sonarr', name: 'Sonarr', enabled: true },
  { id: 5, type: 'qbittorrent', name: 'qBit', enabled: true },
  { id: 6, type: 'jellystat', name: 'JStat', enabled: true },
  { id: 7, type: 'proxmox', name: 'PVE', enabled: true },
  { id: 8, type: 'jellyfin', name: 'Disabled', enabled: false }
];

describe('densityForWidth', () => {
  it('buckets width-in-columns into a content-density size', () => {
    expect(densityForWidth(1)).toBe('s');
    expect(densityForWidth(3)).toBe('s');
    expect(densityForWidth(4)).toBe('m');
    expect(densityForWidth(5)).toBe('m');
    expect(densityForWidth(6)).toBe('l');
    expect(densityForWidth(8)).toBe('l');
    expect(densityForWidth(9)).toBe('full');
    expect(densityForWidth(12)).toBe('full');
  });

  it('is monotonic non-decreasing across the grid', () => {
    const order = { s: 0, m: 1, l: 2, full: 3 } as const;
    let prev = -1;
    for (let w = 1; w <= GRID_COLUMNS; w++) {
      const cur = order[densityForWidth(w)];
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

describe('GRID_COLUMNS', () => {
  it('is a 12-column grid', () => {
    expect(GRID_COLUMNS).toBe(12);
  });
});

describe('buildWidgetInstances', () => {
  it('always includes nowplaying and containers; watch when any watch source exists', () => {
    const inst = buildWidgetInstances([]);
    // No connections → no watch sources → no watch widget
    expect(inst.map((i) => i.key)).toEqual(['nowplaying', 'containers']);
  });

  it('includes the watch widget when a jellyfin connection exists', () => {
    const keys = buildWidgetInstances(conns).map((i) => i.key);
    expect(keys).toContain('watch');
  });

  it('builds per-connection instances with stable keys and skips disabled', () => {
    const keys = buildWidgetInstances(conns).map((i) => i.key);
    expect(keys).toContain('recentlyadded:1');
    expect(keys).toContain('requests:2');
    expect(keys).toContain('queue:3');
    expect(keys).toContain('queue:4');
    expect(keys).toContain('torrents:5');
    // watch is now a single global widget (not per-jellystat)
    expect(keys).not.toContain('mostwatched:6');
    expect(keys).toContain('proxmoxhost:7');
    // disabled jellyfin (id 8) excluded
    expect(keys).not.toContain('recentlyadded:8');
    // old separate widgets are gone
    expect(keys).not.toContain('recentlywatched');
    expect(keys).not.toContain('mostwatched');
  });

  it('includes the watch widget when any tautulli or jellystat conn exists', () => {
    // conns includes jellystat (id 6) → watch should appear as a global
    const keys = buildWidgetInstances(conns).map((i) => i.key);
    expect(keys).toContain('watch');
  });

  it('includes watch when only seerr/radarr/sonarr conns exist (no watch source)', () => {
    const noWatchConns: DashConnection[] = [
      { id: 1, type: 'seerr', name: 'Seerr', enabled: true },
      { id: 2, type: 'radarr', name: 'Radarr', enabled: true }
    ];
    const keys = buildWidgetInstances(noWatchConns).map((i) => i.key);
    expect(keys).not.toContain('watch');
  });

  it('includes watch when a tautulli conn exists', () => {
    const tautulliConns: DashConnection[] = [
      { id: 1, type: 'tautulli', name: 'Tau', enabled: true }
    ];
    const keys = buildWidgetInstances(tautulliConns).map((i) => i.key);
    expect(keys).toContain('watch');
  });

  it('labels radarr/sonarr queues', () => {
    const inst = buildWidgetInstances(conns);
    expect(inst.find((i) => i.key === 'queue:3')?.label).toBe('Radarr');
    expect(inst.find((i) => i.key === 'queue:4')?.label).toBe('Sonarr');
  });

  it('assigns sensible default widths per kind and a height >= the kind minimum', () => {
    const inst = buildWidgetInstances(conns);
    const box = (k: string) => {
      const i = inst.find((x) => x.key === k);
      return i && { w: i.defaultW, h: i.defaultH };
    };
    // Widths are fixed presets (media-forward defaults).
    expect(box('nowplaying')!.w).toBe(8);      // prominent wide panel
    expect(box('watch')!.w).toBe(4);           // right sidebar
    expect(box('containers')!.w).toBe(4);      // right sidebar
    expect(box('recentlyadded:1')!.w).toBe(8); // wide carousel
    expect(box('requests:2')!.w).toBe(8);      // wide carousel
    expect(box('queue:3')!.w).toBe(4);
    expect(box('torrents:5')!.w).toBe(4);
    expect(box('proxmoxhost:7')!.w).toBe(4);
    // Heights are in the scale cell grid and never below the kind minimum.
    for (const k of ['nowplaying', 'watch', 'containers', 'recentlyadded:1', 'requests:2', 'queue:3', 'torrents:5', 'proxmoxhost:7']) {
      const i = inst.find((x) => x.key === k)!;
      expect(i.defaultH).toBeGreaterThanOrEqual(minHForKind(i.kind));
    }
  });
});

describe('mergeLayout', () => {
  it('appends all instances as visible defaults (auto-placed) when nothing is saved', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout([], inst);
    expect(merged).toHaveLength(2); // nowplaying + containers (no watch source)
    expect(merged.every((m) => m.visible && !m.collapsed)).toBe(true);
    // New instances get no x/y (GridStack auto-places) and their default w/h.
    expect(merged.every((m) => m.x === undefined && m.y === undefined)).toBe(true);
    expect(merged[0].w).toBe(8); // nowplaying default: wide 8-col media panel
    expect(merged[0].h).toBe(inst[0].defaultH);
  });

  it('keeps saved x/y/w/visible/collapsed for existing keys, drops missing, appends new', () => {
    const inst = buildWidgetInstances([]); // nowplaying, containers (no watch source)
    // A saved height that's already on the modular scale (Medium) survives unchanged.
    const npH = HEIGHT_SCALE.medium;
    const saved: SavedLayoutEntry[] = [
      // Collapsed: stores its real (expanded) height. Already a new-scale cell-count (2).
      { key: 'containers', x: 0, y: 2, w: 3, h: 2, visible: false, collapsed: true },
      { key: 'gone', x: 1, y: 1, w: 4, h: 4, visible: true, collapsed: false },
      { key: 'nowplaying', x: 3, y: 0, w: 12, h: npH, visible: true, collapsed: false }
    ];
    const merged = mergeLayout(saved, inst);
    // Order follows instances order (stable), NOT saved order.
    expect(merged.map((m) => m.key)).toEqual(['nowplaying', 'containers']);

    const np = merged.find((m) => m.key === 'nowplaying')!;
    expect(np).toMatchObject({ x: 3, y: 0, w: 12, h: npH, visible: true });

    // Collapsed keeps its stored real height (the grid forces a small collapsed h at runtime).
    const cont = merged.find((m) => m.key === 'containers')!;
    expect(cont).toMatchObject({ x: 0, y: 2, w: 3, h: 2, visible: false, collapsed: true });

    // 'gone' dropped
    expect(merged.find((m) => m.key === 'gone')).toBeUndefined();
  });

  it('falls back to default w/h when saved w/h are invalid, and clamps w to the grid', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout(
      [
        { key: 'nowplaying', w: NaN as unknown as number, h: undefined as unknown as number, visible: true, collapsed: false },
        { key: 'containers', x: 0, y: 0, w: 99, h: 5, visible: true, collapsed: false }
      ],
      inst
    );
    const np = merged.find((m) => m.key === 'nowplaying')!;
    expect(np.w).toBe(8); // default (wide media panel)
    expect(np.h).toBe(inst.find((i) => i.key === 'nowplaying')!.defaultH); // default
    const cont = merged.find((m) => m.key === 'containers')!;
    expect(cont.w).toBe(GRID_COLUMNS); // clamped (h=5 > XL=4, snaps to XL)
  });

  it('ignores duplicate saved keys (first wins)', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout(
      [
        { key: 'nowplaying', x: 0, y: 0, w: 3, h: 3, visible: true, collapsed: false },
        { key: 'nowplaying', x: 5, y: 5, w: 12, h: 5, visible: false, collapsed: true }
      ],
      inst
    );
    const np = merged.filter((m) => m.key === 'nowplaying');
    expect(np).toHaveLength(1);
    expect(np[0]).toMatchObject({ x: 0, w: 3 });
  });
});

describe('toSavedLayout', () => {
  it('keeps only persistable fields', () => {
    const merged = mergeLayout(
      [{ key: 'nowplaying', x: 1, y: 2, w: 6, h: 3, visible: true, collapsed: false }],
      buildWidgetInstances([])
    );
    const saved = toSavedLayout(merged);
    expect(Object.keys(saved[0]).sort()).toEqual([
      'collapsed',
      'h',
      'key',
      'visible',
      'w',
      'x',
      'y'
    ]);
  });
});

describe('preset cell grid: cellHeight is the base unit', () => {
  it('cellHeight IS the base "Small" height (~150px), so one cell == one preset step', () => {
    expect(CELL_HEIGHT).toBe(150);
    expect(GRID_MARGIN).toBe(10);
  });

  it('pxForH(1) is the usable content height of one base cell (cell minus margins)', () => {
    expect(pxForH(1)).toBe(CELL_HEIGHT - 2 * GRID_MARGIN); // 130
    expect(pxForH(2)).toBe(2 * CELL_HEIGHT - 2 * GRID_MARGIN);
  });
});

describe('modular height scale', () => {
  it('the base unit is one cell, so heights are small whole cell-counts (1/2/3/4)', () => {
    expect(BASE_H).toBe(1);
    expect(HEIGHT_SCALE.small).toBe(1);
    expect(HEIGHT_SCALE.medium).toBe(2);
    expect(HEIGHT_SCALE.large).toBe(3);
    expect(HEIGHT_SCALE.xl).toBe(4);
  });

  it('every preset is an exact integer multiple of BASE_H so they compose & align', () => {
    expect(HEIGHT_SCALE.small).toBe(BASE_H);
    expect(HEIGHT_SCALE.medium).toBe(2 * BASE_H);
    expect(HEIGHT_SCALE.large).toBe(3 * BASE_H);
    expect(HEIGHT_SCALE.xl).toBe(4 * BASE_H);
  });

  it('the compose relationship holds: Small+Small=Medium, Small+Medium=Large, Medium+Medium=XL', () => {
    expect(HEIGHT_SCALE.small + HEIGHT_SCALE.small).toBe(HEIGHT_SCALE.medium);
    expect(HEIGHT_SCALE.small + HEIGHT_SCALE.medium).toBe(HEIGHT_SCALE.large);
    expect(HEIGHT_SCALE.medium + HEIGHT_SCALE.medium).toBe(HEIGHT_SCALE.xl);
  });

  it('SCALE_HEIGHTS is the strictly-increasing list of presets', () => {
    expect(SCALE_HEIGHTS).toEqual([
      HEIGHT_SCALE.small,
      HEIGHT_SCALE.medium,
      HEIGHT_SCALE.large,
      HEIGHT_SCALE.xl
    ]);
    for (let i = 1; i < SCALE_HEIGHTS.length; i++) {
      expect(SCALE_HEIGHTS[i]).toBeGreaterThan(SCALE_HEIGHTS[i - 1]);
    }
  });

  it('Small is ≈150px of content tall (header + ~2 list rows)', () => {
    const px = pxForH(HEIGHT_SCALE.small);
    expect(px).toBeGreaterThanOrEqual(120);
    expect(px).toBeLessThanOrEqual(180);
  });
});

describe('snapToScale', () => {
  it('snaps an arbitrary height to the nearest scale preset', () => {
    expect(snapToScale(HEIGHT_SCALE.small)).toBe(HEIGHT_SCALE.small);
    expect(snapToScale(HEIGHT_SCALE.small + 0.2)).toBe(HEIGHT_SCALE.small);
    expect(snapToScale(HEIGHT_SCALE.medium - 0.2)).toBe(HEIGHT_SCALE.medium);
    expect(snapToScale(1000)).toBe(HEIGHT_SCALE.xl); // clamp to tallest
    expect(snapToScale(0)).toBe(HEIGHT_SCALE.small); // clamp to shortest
  });

  it('only ever returns a value on the scale (never an in-between height)', () => {
    for (let h = 1; h <= 120; h++) {
      expect(SCALE_HEIGHTS).toContain(snapToScale(h));
    }
  });

  it('respects the [minH, maxH] window so list widgets stay Small..XL', () => {
    const { minH, maxH } = heightBoundsForKind('containers');
    expect(snapToScale(1000, minH, maxH)).toBe(maxH); // never above XL
    expect(snapToScale(0, minH, maxH)).toBe(minH); // never below Small
    // XL IS now the max for list widgets → selecting it is valid.
    expect(snapToScale(HEIGHT_SCALE.xl, minH, maxH)).toBe(HEIGHT_SCALE.xl);
    // Above XL is clamped to XL.
    expect(snapToScale(100, minH, maxH)).toBe(HEIGHT_SCALE.xl);
  });

  it('on a tie prefers the LARGER preset so a widget never under-fills', () => {
    // midpoint between Small (1) and Medium (2) is 1.5.
    expect(snapToScale(1.5)).toBe(HEIGHT_SCALE.medium);
  });

  it('a fixed-height kind (min == max) always snaps to its single block', () => {
    const { minH, maxH } = heightBoundsForKind('recentlyadded');
    expect(minH).toBe(maxH);
    expect(snapToScale(HEIGHT_SCALE.small, minH, maxH)).toBe(HEIGHT_SCALE.medium);
    expect(snapToScale(HEIGHT_SCALE.xl, minH, maxH)).toBe(HEIGHT_SCALE.medium);
  });
});

describe('heightBoundsForKind / min/max per kind', () => {
  it('list widgets span Small..XL (maxH raised to XL so users can size them two Mediums tall)', () => {
    for (const k of ['containers', 'nowplaying', 'watch', 'downloadqueue', 'torrents']) {
      const b = heightBoundsForKind(k);
      expect(b.minH).toBe(HEIGHT_SCALE.small);
      expect(b.maxH).toBe(HEIGHT_SCALE.xl);
      expect(isFixedHeightKind(k)).toBe(false);
    }
  });

  it('poster/carousel widgets are fixed at Medium (min == max, not resizable)', () => {
    for (const k of ['recentlyadded', 'requests']) {
      const b = heightBoundsForKind(k);
      expect(b.minH).toBe(HEIGHT_SCALE.medium);
      expect(b.maxH).toBe(HEIGHT_SCALE.medium);
      expect(isFixedHeightKind(k)).toBe(true);
    }
  });

  it('ProxmoxHost spans Small..Medium', () => {
    const b = heightBoundsForKind('proxmoxhost');
    expect(b.minH).toBe(HEIGHT_SCALE.small);
    expect(b.maxH).toBe(HEIGHT_SCALE.medium);
    expect(isFixedHeightKind('proxmoxhost')).toBe(false);
  });

  it('minHForKind / maxHForKind expose the bounds; unknown kinds fall back to Small..XL', () => {
    expect(minHForKind('containers')).toBe(HEIGHT_SCALE.small);
    expect(maxHForKind('containers')).toBe(HEIGHT_SCALE.xl);
    expect(minHForKind('something-new')).toBe(HEIGHT_SCALE.small);
    expect(maxHForKind('something-new')).toBe(HEIGHT_SCALE.xl);
  });
});

describe('mergeLayout snaps saved heights onto the modular scale', () => {
  it('migrates a LEGACY 6px-cell height (old Medium ≈ 50) onto the new Medium cell-count', () => {
    const inst = buildWidgetInstances([]); // includes nowplaying, containers (no watch source)
    const merged = mergeLayout(
      [
        // Legacy heights: old Medium=50 cells, old Small=25 cells (counts of 6px cells).
        { key: 'nowplaying', x: 0, y: 0, w: 6, h: 50, visible: true, collapsed: false },
        { key: 'containers', x: 0, y: 0, w: 4, h: 25, visible: true, collapsed: false }
      ],
      inst
    );
    expect(merged.find((m) => m.key === 'nowplaying')!.h).toBe(HEIGHT_SCALE.medium);
    expect(merged.find((m) => m.key === 'containers')!.h).toBe(HEIGHT_SCALE.small);
  });

  it('keeps a new-scale cell-count (1..4) and snaps it within the kind bounds', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout(
      [{ key: 'nowplaying', x: 0, y: 0, w: 6, h: HEIGHT_SCALE.medium, visible: true, collapsed: false }],
      inst
    );
    expect(merged.find((m) => m.key === 'nowplaying')!.h).toBe(HEIGHT_SCALE.medium);
  });

  it('snaps an off-scale tall height down to the nearest preset within the kind bounds', () => {
    const inst = buildWidgetInstances([]);
    // containers (list) now maxes at XL (4); a saved 1000 collapses to XL.
    const merged = mergeLayout(
      [{ key: 'containers', x: 0, y: 0, w: 4, h: 1000, visible: true, collapsed: false }],
      inst
    );
    expect(merged.find((m) => m.key === 'containers')!.h).toBe(HEIGHT_SCALE.xl);
  });

  it('leaves an on-scale height within bounds untouched', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout(
      [{ key: 'nowplaying', x: 0, y: 0, w: 6, h: HEIGHT_SCALE.medium, visible: true, collapsed: false }],
      inst
    );
    expect(merged.find((m) => m.key === 'nowplaying')!.h).toBe(HEIGHT_SCALE.medium);
  });

  it('migrates a fixed-height poster widget to its single Medium block', () => {
    const conns2: DashConnection[] = [{ id: 1, type: 'jellyfin', name: 'JF', enabled: true }];
    const inst = buildWidgetInstances(conns2);
    const merged = mergeLayout(
      [{ key: 'recentlyadded:1', x: 0, y: 0, w: 8, h: 99, visible: true, collapsed: false }],
      inst
    );
    expect(merged.find((m) => m.key === 'recentlyadded:1')!.h).toBe(HEIGHT_SCALE.medium);
  });

  it('does not raise a collapsed widget height (collapsed keeps its real stored h)', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout(
      [{ key: 'nowplaying', x: 0, y: 0, w: 6, h: 1, visible: true, collapsed: true }],
      inst
    );
    // collapsed → stored real height kept (>=1), not snapped to the scale
    expect(merged.find((m) => m.key === 'nowplaying')!.h).toBe(1);
  });

  it('new auto-placed instances land on a valid scale height within their kind bounds', () => {
    const inst = buildWidgetInstances([]);
    const merged = mergeLayout([], inst);
    for (const m of merged) {
      const { minH, maxH } = heightBoundsForKind(m.kind);
      expect(SCALE_HEIGHTS).toContain(m.h);
      expect(m.h).toBeGreaterThanOrEqual(minH);
      expect(m.h).toBeLessThanOrEqual(maxH);
    }
  });
});

describe('freeRectAt', () => {
  const self: GridRect = { x: 0, y: 0, w: 3, h: 2 };

  it('on an empty grid the free rect spans to the right edge and keeps own height', () => {
    const { freeW, freeH } = freeRectAt(self, []);
    expect(freeW).toBe(GRID_COLUMNS); // columns 0..11 all free
    expect(freeH).toBe(self.h); // nothing below → own height is the floor
  });

  it('stops freeW at the left edge of a neighbour on the same row', () => {
    const others: GridRect[] = [{ x: 6, y: 0, w: 3, h: 4 }];
    const { freeW } = freeRectAt(self, others);
    expect(freeW).toBe(6); // free columns 0..5
  });

  it('ignores neighbours that do not cover the anchor row', () => {
    // neighbour is far below the top row → does not constrain freeW
    const others: GridRect[] = [{ x: 4, y: 10, w: 3, h: 2 }];
    const { freeW } = freeRectAt(self, others);
    expect(freeW).toBe(GRID_COLUMNS);
  });

  it('stops freeH at the first widget below within the free columns', () => {
    const others: GridRect[] = [{ x: 0, y: 5, w: 4, h: 3 }];
    const { freeW, freeH } = freeRectAt(self, others);
    expect(freeW).toBe(GRID_COLUMNS);
    expect(freeH).toBe(5); // rows 0..4 free, blocker starts at row 5
  });

  it('only counts a below-blocker if it overlaps the free columns', () => {
    // blocker is to the right of freeW span → does not limit height
    const wide: GridRect = { x: 0, y: 0, w: 4, h: 2 };
    const others: GridRect[] = [
      { x: 6, y: 0, w: 3, h: 8 }, // limits freeW to 6
      { x: 8, y: 3, w: 2, h: 2 } // below but outside cols 0..5 → ignored for freeH
    ];
    const { freeW, freeH } = freeRectAt(wide, others);
    expect(freeW).toBe(6);
    expect(freeH).toBe(wide.h); // no blocker inside cols 0..5 below → own height
  });

  it('never shrinks below the widget current size', () => {
    const big: GridRect = { x: 0, y: 0, w: 8, h: 6 };
    // a neighbour right at x=2 would suggest freeW=2, but we never go below w
    const others: GridRect[] = [{ x: 2, y: 0, w: 2, h: 2 }];
    const { freeW, freeH } = freeRectAt(big, others);
    expect(freeW).toBeGreaterThanOrEqual(big.w);
    expect(freeH).toBeGreaterThanOrEqual(big.h);
  });
});

describe('SIZE_PRESETS', () => {
  it('maps each preset to a width within the grid', () => {
    for (const s of ['s', 'm', 'l', 'full'] as const) {
      expect(SIZE_PRESETS[s].w).toBeGreaterThanOrEqual(1);
      expect(SIZE_PRESETS[s].w).toBeLessThanOrEqual(GRID_COLUMNS);
    }
    expect(SIZE_PRESETS.full.w).toBe(GRID_COLUMNS);
  });
});

// ---------------------------------------------------------------------------
// reconcileLayout
// ---------------------------------------------------------------------------

/** Build a minimal LayoutEntry for use in reconcile tests. */
function makeEntry(
  key: string,
  kind: string,
  overrides: Partial<LayoutEntry> = {}
): LayoutEntry {
  return {
    key,
    kind,
    title: key,
    defaultW: 4,
    defaultH: HEIGHT_SCALE.medium,
    x: 0,
    y: 0,
    w: 4,
    h: HEIGHT_SCALE.medium,
    visible: true,
    collapsed: false,
    ...overrides
  };
}

/** Build a minimal WidgetInstance for use in reconcile tests. */
function makeInst(key: string, kind: string): WidgetInstance {
  return { key, kind, title: key, defaultW: 4, defaultH: HEIGHT_SCALE.medium };
}

describe('reconcileLayout', () => {
  it('preserves hidden state: a hidden widget stays hidden after reconcile', () => {
    const current: LayoutEntry[] = [
      makeEntry('nowplaying', 'nowplaying', { visible: false }),
      makeEntry('containers', 'containers')
    ];
    const instances = [makeInst('nowplaying', 'nowplaying'), makeInst('containers', 'containers')];
    const result = reconcileLayout(current, instances);
    // Same reference (nothing changed).
    expect(result).toBe(current);
    expect(result.find((e) => e.key === 'nowplaying')!.visible).toBe(false);
  });

  it('preserves custom x/y/w/h/collapsed without resetting them', () => {
    const current: LayoutEntry[] = [
      makeEntry('containers', 'containers', {
        x: 5,
        y: 3,
        w: 8,
        h: HEIGHT_SCALE.large,
        collapsed: true
      })
    ];
    const instances = [makeInst('containers', 'containers')];
    const result = reconcileLayout(current, instances);
    expect(result).toBe(current); // same ref — nothing changed
    const e = result[0];
    expect(e.x).toBe(5);
    expect(e.y).toBe(3);
    expect(e.w).toBe(8);
    expect(e.h).toBe(HEIGHT_SCALE.large);
    expect(e.collapsed).toBe(true);
  });

  it('appends a NEW instance that was not in current layout (visible, no x/y)', () => {
    const current: LayoutEntry[] = [makeEntry('nowplaying', 'nowplaying')];
    const instances = [
      makeInst('nowplaying', 'nowplaying'),
      makeInst('containers', 'containers')
    ];
    const result = reconcileLayout(current, instances);
    expect(result).not.toBe(current); // new array produced
    expect(result).toHaveLength(2);
    const newEntry = result.find((e) => e.key === 'containers')!;
    expect(newEntry).toBeDefined();
    expect(newEntry.visible).toBe(true);
    expect(newEntry.collapsed).toBe(false);
    expect(newEntry.x).toBeUndefined();
    expect(newEntry.y).toBeUndefined();
  });

  it('drops entries whose instance no longer exists (removed connection)', () => {
    const current: LayoutEntry[] = [
      makeEntry('nowplaying', 'nowplaying'),
      makeEntry('recentlyadded:99', 'recentlyadded') // connection 99 removed
    ];
    const instances = [makeInst('nowplaying', 'nowplaying')]; // no recentlyadded:99
    const result = reconcileLayout(current, instances);
    expect(result).not.toBe(current);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('nowplaying');
    expect(result.find((e) => e.key === 'recentlyadded:99')).toBeUndefined();
  });

  it('drops removed AND appends new in the same call without resetting existing', () => {
    const current: LayoutEntry[] = [
      makeEntry('nowplaying', 'nowplaying', { x: 2, y: 1, visible: false }),
      makeEntry('old:1', 'downloadqueue') // will be removed
    ];
    const instances = [
      makeInst('nowplaying', 'nowplaying'),
      makeInst('containers', 'containers') // new
    ];
    const result = reconcileLayout(current, instances);
    expect(result).toHaveLength(2);
    // nowplaying: local state preserved (hidden, custom position)
    const np = result.find((e) => e.key === 'nowplaying')!;
    expect(np.visible).toBe(false);
    expect(np.x).toBe(2);
    expect(np.y).toBe(1);
    // containers: new, auto-placed
    const c = result.find((e) => e.key === 'containers')!;
    expect(c.visible).toBe(true);
    expect(c.x).toBeUndefined();
    // old:1 dropped
    expect(result.find((e) => e.key === 'old:1')).toBeUndefined();
  });

  it('returns the SAME reference when keys are unchanged (no unnecessary layout writes)', () => {
    const current: LayoutEntry[] = [
      makeEntry('nowplaying', 'nowplaying'),
      makeEntry('containers', 'containers')
    ];
    const instances = [
      makeInst('nowplaying', 'nowplaying'),
      makeInst('containers', 'containers')
    ];
    const result = reconcileLayout(current, instances);
    expect(result).toBe(current); // exact same array — no new object created
  });

  it('new entry height is snapped to the modular scale within kind bounds', () => {
    const current: LayoutEntry[] = [];
    const inst: WidgetInstance = {
      key: 'containers',
      kind: 'containers',
      title: 'Containers',
      defaultW: 4,
      defaultH: HEIGHT_SCALE.medium
    };
    const result = reconcileLayout(current, [inst]);
    const { minH, maxH } = heightBoundsForKind('containers');
    expect(SCALE_HEIGHTS).toContain(result[0].h);
    expect(result[0].h).toBeGreaterThanOrEqual(minH);
    expect(result[0].h).toBeLessThanOrEqual(maxH);
  });

  it('does NOT pull from data.layout — only reconciles keys/local state', () => {
    // The critical property: reconcile never re-reads the server snapshot.
    // Simulate: user hid "nowplaying" locally, then a connection is added.
    // reconcileLayout should keep nowplaying hidden; only the new instance is appended.
    const current: LayoutEntry[] = [
      makeEntry('nowplaying', 'nowplaying', { visible: false, x: 4, y: 2 })
    ];
    const instances = [
      makeInst('nowplaying', 'nowplaying'),
      makeInst('containers', 'containers')
    ];
    const result = reconcileLayout(current, instances);
    expect(result.find((e) => e.key === 'nowplaying')!.visible).toBe(false);
    expect(result.find((e) => e.key === 'nowplaying')!.x).toBe(4);
  });
});
