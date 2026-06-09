// Shared sizing helpers for widget content — pure functions, SSR-safe.
// Import WidgetSize from dashboard to keep the single source of truth.
import type { WidgetSize } from '$lib/dashboard';

/**
 * How many list-rows a widget should render for a given size.
 * Pass custom `caps` to tune per-widget (the defaults are sensible for most
 * vertical-list widgets).
 */
export function capForSize(
  size: WidgetSize | undefined,
  caps: Record<WidgetSize, number> = { s: 4, m: 6, l: 8, full: 12 }
): number {
  return caps[size ?? 'm'];
}

/**
 * How many poster columns (or how many carousel items are "snapped into view")
 * for a given size. Wider grid = more posters visible before scrolling.
 */
export function colsForSize(size: WidgetSize | undefined): number {
  return ({ s: 2, m: 3, l: 4, full: 6 } as Record<WidgetSize, number>)[size ?? 'm'];
}
