import { describe, it, expect } from 'vitest';
import { truncateToolResult, DEFAULT_MAX_TOOL_RESULT_CHARS } from './truncate';

const size = (v: unknown) => JSON.stringify(v).length;

describe('truncateToolResult', () => {
  it('returns small results unchanged (same reference)', () => {
    const small = { status: 200, data: [{ id: 1, title: 'X' }] };
    expect(truncateToolResult(small)).toBe(small);
  });

  it('truncates a huge array to the char budget and reports how many items were dropped', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, pad: 'x'.repeat(200) }));
    const out: any = truncateToolResult(items, 10_000);
    expect(size(out)).toBeLessThanOrEqual(10_000);
    expect(out.truncated).toBe(true);
    expect(out.totalItems).toBe(500);
    expect(out.shownItems).toBeGreaterThan(0);
    expect(out.shownItems).toBeLessThan(500);
    expect(out.items[0]).toEqual(items[0]);
    expect(out.note).toMatch(/truncated/i);
  });

  it('truncates the oversized array inside an object wrapper, preserving the other fields', () => {
    const releases = Array.from({ length: 300 }, (_, i) => ({ guid: `g${i}`, title: 'x'.repeat(300) }));
    const out: any = truncateToolResult({ status: 200, data: releases }, 12_000);
    expect(size(out)).toBeLessThanOrEqual(12_000);
    expect(out.status).toBe(200);
    expect(out.data.truncated).toBe(true);
    expect(out.data.items[0]).toEqual(releases[0]);
  });

  it('truncates a huge string with a marker', () => {
    const out = truncateToolResult('a'.repeat(50_000), 10_000) as string;
    expect(out.length).toBeLessThanOrEqual(10_000);
    expect(out).toMatch(/truncated/i);
  });

  it('falls back to a JSON preview for oversized values with no dominant array', () => {
    const blob: Record<string, string> = {};
    for (let i = 0; i < 200; i++) blob[`k${i}`] = 'v'.repeat(100);
    const out: any = truncateToolResult(blob, 5_000);
    expect(size(out)).toBeLessThanOrEqual(5_000);
    expect(out.truncated).toBe(true);
    expect(typeof out.preview).toBe('string');
  });

  it('has a default budget large enough for normal widget payloads', () => {
    expect(DEFAULT_MAX_TOOL_RESULT_CHARS).toBeGreaterThanOrEqual(10_000);
  });
});
