import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import * as http from '../http';
import { getShowcasePosters, getShowcaseTitles, _resetShowcaseCache } from './showcase';
import { SEERR_PATHS } from './types';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  _resetShowcaseCache();
});
afterEach(() => { vi.restoreAllMocks(); _resetShowcaseCache(); });

describe('showcase posters', () => {
  it('returns [] when no seerr connection exists', async () => {
    expect(await getShowcasePosters(db)).toEqual([]);
  });

  it('maps seerr trending poster paths to public TMDB URLs (movie + tv only, capped at 20)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    const results = [
      { id: 1, mediaType: 'movie', posterPath: '/a.jpg' },
      { id: 2, mediaType: 'tv', posterPath: '/b.jpg' },
      { id: 3, mediaType: 'person', posterPath: '/skip.jpg' }, // not movie/tv → skipped
      { id: 4, mediaType: 'movie', posterPath: null },          // no poster → skipped
      ...Array.from({ length: 25 }, (_, i) => ({ id: 100 + i, mediaType: 'movie', posterPath: `/x${i}.jpg` }))
    ];
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ results } as any);
    const posters = await getShowcasePosters(db);
    expect(posters.length).toBe(20);
    expect(posters[0]).toBe('https://image.tmdb.org/t/p/w342/a.jpg');
    expect(posters[1]).toBe('https://image.tmdb.org/t/p/w342/b.jpg');
    expect(posters.every((p) => p.startsWith('https://image.tmdb.org/t/p/w342'))).toBe(true);
  });

  it('returns [] when seerr is down (fetch throws)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    vi.spyOn(http, 'getJsonWithKey').mockRejectedValue(new Error('HTTP 500'));
    expect(await getShowcasePosters(db)).toEqual([]);
  });

  it('caches the result (second call does not re-hit seerr)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    const spy = vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      results: [{ id: 1, mediaType: 'movie', posterPath: '/a.jpg' }]
    } as any);
    await getShowcasePosters(db);
    await getShowcasePosters(db);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('showcase title cards', () => {
  // Only the trending endpoint returns the mixed set; the discover-by-type endpoints are empty,
  // so the realistic movie/tv mediaType filtering is exercised (no forced-type test artifacts).
  function mockTrending(results: unknown[]) {
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) =>
      (String(url).includes(SEERR_PATHS.trending) ? { results } : { results: [] }) as any
    );
  }

  it('returns empty lists when no seerr connection exists', async () => {
    expect(await getShowcaseTitles(db)).toEqual({ available: [], request: [] });
  });

  it('splits on-server (status 5) from requestable, skips requested/non-media/poster-less', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    mockTrending([
      { id: 1, mediaType: 'movie', title: 'On Server A', releaseDate: '2020-05-01', posterPath: '/a.jpg', voteAverage: 8.2, mediaInfo: { status: 5 } },
      { id: 2, mediaType: 'tv', name: 'On Server B', firstAirDate: '2019-01-01', posterPath: '/b.jpg', mediaInfo: { status: 5 } },
      { id: 3, mediaType: 'movie', title: 'Requestable', releaseDate: '2021-03-01', posterPath: '/c.jpg' },          // no mediaInfo → requestable
      { id: 4, mediaType: 'movie', title: 'Already Requested', releaseDate: '2022-01-01', posterPath: '/d.jpg', mediaInfo: { status: 3 } }, // pending → neither
      { id: 5, mediaType: 'person', title: 'A Person', posterPath: '/p.jpg' },   // not movie/tv → skipped
      { id: 6, mediaType: 'movie', title: 'No Poster', posterPath: null }        // no poster → skipped
    ]);

    const { available, request } = await getShowcaseTitles(db);

    expect(available.map((t) => t.title)).toEqual(['On Server A', 'On Server B']);
    expect(available[0]).toMatchObject({ year: 2020, rating: 8.2, poster: 'https://image.tmdb.org/t/p/w342/a.jpg', mediaType: 'movie' });
    expect(request.map((t) => t.title)).toEqual(['Requestable']);
    expect(request[0].poster).toBe('https://image.tmdb.org/t/p/w342/c.jpg');
  });

  it('dedupes the same title across endpoints and caps each list at 8', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, mediaType: 'movie', title: `Req ${i}`, releaseDate: '2021-01-01', posterPath: `/r${i}.jpg`
    }));
    // A duplicate (same title+year) should collapse to a single card.
    many.push({ id: 99, mediaType: 'movie', title: 'Req 0', releaseDate: '2021-01-01', posterPath: '/dup.jpg' });
    mockTrending(many);

    const { request } = await getShowcaseTitles(db);
    expect(request.length).toBe(8);
    expect(new Set(request.map((t) => t.title)).size).toBe(8); // all unique
  });

  it('caches the result (second call does not re-hit seerr)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
    const spy = vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({ results: [] } as any);
    await getShowcaseTitles(db);
    await getShowcaseTitles(db);
    expect(spy).toHaveBeenCalledTimes(3); // one batch of 3 endpoints, then served from cache
  });
});
