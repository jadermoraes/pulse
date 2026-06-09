// Fit-to-height helper for vertical-list widgets.
//
// Each list widget renders exactly the number of rows that FIT its current body
// height (so content fills the GridStack cell with NO scrollbar and no empty gap).
// A ResizeObserver watches the body container; whenever its height changes we
// compute `floor(bodyPx / rowPx)` and report it back. The widget then renders
// `Math.min(totalItems, fit)` rows and clips overflow.
//
// To stop the row-height constant from silently drifting away from the CSS, we
// MEASURE the first rendered row's real height and prefer that over the supplied
// `rowPx` fallback. So even if a row's padding/line-height changes, the fit stays
// exact (N rows that fit → N rows rendered, content reaches the bottom, no gap).
//
// It ALSO reports the widget's measured GEOMETRY (headerPx above the rows + the real
// rowPx) via `onGeometry`, so the dashboard can snap the widget's grid height to an
// exact whole number of content rows (header + N×row) — never a leftover gap, never a
// clip. The geometry fires on mount/data-load only (outside any drag/resize).
//
// Browser-only (uses ResizeObserver); the action is a no-op during SSR.

/** Measured geometry of a list widget, used to compute content-aligned heights. */
export interface RowGeometry {
  /** Fixed chrome above the content rows: top of the list container within the cell. */
  headerPx: number;
  /** The real measured height of one content row. */
  rowPx: number;
}

interface FitRowsParams {
  /** Fallback per-row height in px (used until a real row can be measured). */
  rowPx: number;
  /** Called with the number of rows that fit the current body height. */
  onFit: (rows: number) => void;
  /** Called (outside any drag) with the measured header + row geometry. */
  onGeometry?: (geom: RowGeometry) => void;
}

/** Measure the real height of the first child row, or fall back to rowPx. */
function rowHeight(el: HTMLElement, fallback: number): number {
  const first = el.firstElementChild as HTMLElement | null;
  // offsetHeight is the border-box height — exactly what stacks in a column flexbox.
  const measured = first?.offsetHeight ?? 0;
  return measured > 0 ? measured : fallback;
}

/**
 * The pixel height of the chrome ABOVE the list container `el`, measured from the top
 * of the enclosing grid cell (`.grid-stack-item-content`) to the top of `el`. This is
 * the widget's title/header that is NOT list body. Falls back to offsetTop when no
 * grid-cell ancestor is present (e.g. in tests).
 */
function headerHeight(el: HTMLElement): number {
  const cell = el.closest('.grid-stack-item-content') as HTMLElement | null;
  if (cell) {
    const top = el.getBoundingClientRect().top - cell.getBoundingClientRect().top;
    if (Number.isFinite(top) && top >= 0) return Math.round(top);
  }
  return el.offsetTop;
}

/**
 * Svelte action: observe `el`'s height and report how many rows fit.
 * Uses the measured first-row height (falls back to `rowPx`). Reports at least 1
 * so an empty/very-short body still shows one row. Also reports geometry.
 */
export function fitRows(el: HTMLElement, params: FitRowsParams) {
  let { rowPx, onFit, onGeometry } = params;

  function measure() {
    const bodyPx = el.clientHeight;
    const rowPx2 = rowHeight(el, rowPx);
    const rows = Math.max(1, Math.floor(bodyPx / rowPx2));
    onFit(rows);
    onGeometry?.({ headerPx: headerHeight(el), rowPx: rowPx2 });
  }

  if (typeof ResizeObserver === 'undefined') {
    // SSR / no-RO environment: report a generous fallback once.
    onFit(1);
    return {
      update(next: FitRowsParams) {
        rowPx = next.rowPx;
        onFit = next.onFit;
        onGeometry = next.onGeometry;
      },
      destroy() {}
    };
  }

  // Observe the body (height changes) AND re-measure after rows render: a child
  // mutation (rows appear/disappear) can change the real row height we measure.
  const ro = new ResizeObserver(() => measure());
  ro.observe(el);
  const mo = new MutationObserver(() => measure());
  mo.observe(el, { childList: true });
  measure();

  return {
    update(next: FitRowsParams) {
      rowPx = next.rowPx;
      onFit = next.onFit;
      onGeometry = next.onGeometry;
      measure();
    },
    destroy() {
      ro.disconnect();
      mo.disconnect();
    }
  };
}

/**
 * Svelte action for content-sized widgets (carousels, ProxmoxHost) that render ONE
 * content unit rather than a list of rows. Reports geometry where the whole content
 * block IS the single "row": headerPx = top of `el` within the cell, rowPx = el's own
 * height. The dashboard then treats unitCount=1 → a single clean height.
 *
 * Browser-only; a no-op during SSR.
 */
export function measureBlock(
  el: HTMLElement,
  onGeometry: (geom: RowGeometry) => void
) {
  let cb = onGeometry;

  function measure() {
    const h = el.offsetHeight;
    if (h <= 0) return;
    cb({ headerPx: headerHeight(el), rowPx: h });
  }

  if (typeof ResizeObserver === 'undefined') {
    return {
      update(next: (geom: RowGeometry) => void) {
        cb = next;
      },
      destroy() {}
    };
  }

  const ro = new ResizeObserver(() => measure());
  ro.observe(el);
  measure();

  return {
    update(next: (geom: RowGeometry) => void) {
      cb = next;
      measure();
    },
    destroy() {
      ro.disconnect();
    }
  };
}
