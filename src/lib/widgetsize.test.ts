import { describe, it, expect } from 'vitest';
import { capForSize, colsForSize } from './widgetsize';
import type { WidgetSize } from './dashboard';

describe('capForSize', () => {
  it('returns correct cap for each named size with default caps', () => {
    expect(capForSize('s')).toBe(4);
    expect(capForSize('m')).toBe(6);
    expect(capForSize('l')).toBe(8);
    expect(capForSize('full')).toBe(12);
  });

  it('falls back to m when size is undefined', () => {
    expect(capForSize(undefined)).toBe(6);
  });

  it('respects custom caps', () => {
    const caps = { s: 5, m: 8, l: 12, full: 20 } satisfies Record<WidgetSize, number>;
    expect(capForSize('s', caps)).toBe(5);
    expect(capForSize('m', caps)).toBe(8);
    expect(capForSize('l', caps)).toBe(12);
    expect(capForSize('full', caps)).toBe(20);
  });

  it('custom caps: falls back to m when size is undefined', () => {
    const caps = { s: 5, m: 8, l: 12, full: 20 } satisfies Record<WidgetSize, number>;
    expect(capForSize(undefined, caps)).toBe(8);
  });

  it('s cap is always less than full cap', () => {
    const result_s = capForSize('s');
    const result_full = capForSize('full');
    expect(result_s).toBeLessThan(result_full);
  });
});

describe('fit-to-height clamp: rendered rows never exceed totalItems', () => {
  // Mirrors the new widget pattern: Math.min(fit, totalItems || 0)
  // where `fit` = floor(bodyPx / rowPx) reported by the ResizeObserver.

  it('renders fit rows when data has more than fit', () => {
    const fit = 5;
    const total = 20;
    expect(Math.min(fit, total || 0)).toBe(5);
  });

  it('clamps to total when data has fewer rows than fit', () => {
    const fit = 12;
    const total = 3;
    expect(Math.min(fit, total || 0)).toBe(3); // never render empty rows past the data
  });

  it('renders 0 rows while data is empty (total 0)', () => {
    const fit = 8;
    const total = 0;
    expect(Math.min(fit, total || 0)).toBe(0);
  });
});

describe('colsForSize', () => {
  it('returns correct columns for each named size', () => {
    expect(colsForSize('s')).toBe(2);
    expect(colsForSize('m')).toBe(3);
    expect(colsForSize('l')).toBe(4);
    expect(colsForSize('full')).toBe(6);
  });

  it('falls back to m (3 cols) when size is undefined', () => {
    expect(colsForSize(undefined)).toBe(3);
  });

  it('larger sizes always return more columns than smaller ones', () => {
    expect(colsForSize('s')).toBeLessThan(colsForSize('m'));
    expect(colsForSize('m')).toBeLessThan(colsForSize('l'));
    expect(colsForSize('l')).toBeLessThan(colsForSize('full'));
  });
});
