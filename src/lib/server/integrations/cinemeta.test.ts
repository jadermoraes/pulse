import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { fetchCinemetaMeta, resolveImdbMeta } from './cinemeta';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockJson(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = spy as any;
  return spy;
}

it('maps a cinemeta movie payload', async () => {
  const spy = mockJson(200, { meta: {
    id: 'tt0111161', imdb_id: 'tt0111161', moviedb_id: 278,
    name: 'The Shawshank Redemption', poster: 'https://img/p.jpg', type: 'movie'
  } });
  const m = await fetchCinemetaMeta('tt0111161', 'movie');
  expect(m).toEqual({
    imdbId: 'tt0111161', tmdbId: 278, name: 'The Shawshank Redemption',
    poster: 'https://img/p.jpg', type: 'movie'
  });
  expect((spy.mock.calls[0] as any)[0]).toBe('https://v3-cinemeta.strem.io/meta/movie/tt0111161.json');
});

it('uses the series path for a show', async () => {
  const spy = mockJson(200, { meta: { id: 'tt0903747', imdb_id: 'tt0903747', moviedb_id: 1396, name: 'Breaking Bad', type: 'series' } });
  const m = await fetchCinemetaMeta('tt0903747', 'series');
  expect(m?.tmdbId).toBe(1396);
  expect(m?.poster).toBeNull();
  expect((spy.mock.calls[0] as any)[0]).toBe('https://v3-cinemeta.strem.io/meta/series/tt0903747.json');
});

it('returns null on 404 rather than throwing', async () => {
  mockJson(404, {});
  expect(await fetchCinemetaMeta('tt0000000', 'movie')).toBeNull();
});

it('rejects a malformed payload instead of returning a partial meta', async () => {
  mockJson(200, { meta: { id: 'tt1' } }); // no name, no type
  await expect(fetchCinemetaMeta('tt1', 'movie')).rejects.toThrow();
});

it('resolveImdbMeta caches: a second call makes no fetch', async () => {
  const spy = mockJson(200, { meta: {
    id: 'tt0111161', imdb_id: 'tt0111161', moviedb_id: 278, name: 'Shawshank', poster: null, type: 'movie'
  } });
  expect((await resolveImdbMeta(db, 'tt0111161', 'movie'))?.tmdbId).toBe(278);
  expect((await resolveImdbMeta(db, 'tt0111161', 'movie'))?.tmdbId).toBe(278);
  expect(spy).toHaveBeenCalledTimes(1);
});

it('resolveImdbMeta caches a negative answer too', async () => {
  const spy = mockJson(404, {});
  expect(await resolveImdbMeta(db, 'tt0000000', 'movie')).toBeNull();
  expect(await resolveImdbMeta(db, 'tt0000000', 'movie')).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1);
});
