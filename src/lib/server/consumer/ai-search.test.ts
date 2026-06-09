import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { generateObject } from 'ai';
import * as discover from './discover';
import { aiVibeSearch } from './ai-search';
import type { DiscoverItem } from './types';

// generateObject is a non-configurable ESM export → mock the module to control it.
vi.mock('ai', () => ({ generateObject: vi.fn() }));
const genMock = vi.mocked(generateObject);

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); genMock.mockReset(); });
afterEach(() => vi.restoreAllMocks());

const fakeModel = {} as any;
function item(over: Partial<DiscoverItem>): DiscoverItem {
  return { source: 'seerr', title: 'X', mediaType: 'movie', onServer: false, released: true, ...over };
}

describe('aiVibeSearch', () => {
  it('empty query → no model call, no items, no tokens', async () => {
    const r = await aiVibeSearch(db, fakeModel, '   ');
    expect(genMock).not.toHaveBeenCalled();
    expect(r).toEqual({ items: [], tokens: 0 });
  });

  it('one model call → resolves each suggestion via searchDiscover and meters tokens', async () => {
    genMock.mockResolvedValue({
      object: { titles: [{ title: 'Inception', year: 2010 }, { title: 'Severance' }] },
      usage: { inputTokens: 30, outputTokens: 20 }
    } as any);
    const sd = vi.spyOn(discover, 'searchDiscover').mockImplementation(async (_db, q) => {
      if (q === 'Inception') return [item({ title: 'Inception', year: 2010, tmdbId: 27205 })];
      if (q === 'Severance') return [item({ title: 'Severance', mediaType: 'tv', tmdbId: 95396 })];
      return [];
    });
    const r = await aiVibeSearch(db, fakeModel, 'movies like Inception');
    expect(genMock).toHaveBeenCalledTimes(1);
    expect(sd).toHaveBeenCalledTimes(2);
    expect(r.items.map((i) => i.title)).toEqual(['Inception', 'Severance']);
    expect(r.tokens).toBe(50);
  });

  it('prefers a year-matching candidate when the model gives a year', async () => {
    genMock.mockResolvedValue({
      object: { titles: [{ title: 'Dune', year: 2021 }] },
      usage: { inputTokens: 5, outputTokens: 5 }
    } as any);
    vi.spyOn(discover, 'searchDiscover').mockResolvedValue([
      item({ title: 'Dune', year: 1984, tmdbId: 841 }),
      item({ title: 'Dune', year: 2021, tmdbId: 438631 })
    ]);
    const r = await aiVibeSearch(db, fakeModel, 'cozy sci-fi');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].tmdbId).toBe(438631);
  });

  it('drops unresolved suggestions and dedupes by tmdbId', async () => {
    genMock.mockResolvedValue({
      object: { titles: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] },
      usage: { inputTokens: 1, outputTokens: 1 }
    } as any);
    vi.spyOn(discover, 'searchDiscover').mockImplementation(async (_db, q) => {
      if (q === 'A') return [item({ title: 'A', tmdbId: 1 })];
      if (q === 'B') return []; // unresolved → dropped
      if (q === 'C') return [item({ title: 'A dup', tmdbId: 1 })]; // dup tmdbId → dropped
      return [];
    });
    const r = await aiVibeSearch(db, fakeModel, 'whatever');
    expect(r.items.map((i) => i.tmdbId)).toEqual([1]);
  });

  it('caps at 8 resolved items', async () => {
    const titles = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}` }));
    genMock.mockResolvedValue({
      object: { titles: titles.slice(0, 8) }, // schema maxes at 8
      usage: { inputTokens: 1, outputTokens: 1 }
    } as any);
    vi.spyOn(discover, 'searchDiscover').mockImplementation(async (_db, q) =>
      [item({ title: q, tmdbId: Number(q.slice(1)) + 1 })]);
    const r = await aiVibeSearch(db, fakeModel, 'lots');
    expect(r.items.length).toBeLessThanOrEqual(8);
  });
});
