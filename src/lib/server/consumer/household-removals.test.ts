import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  enqueueHouseholdRemoval, listHouseholdRemovals, clearHouseholdRemovals
} from './household-removals';

let db: DB;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  db = openDb(':memory:');
  migrate(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedMeta(imdb: string, tmdb: number, type: 'movie' | 'series'): void {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES (?,?,?,'X',NULL,1,?)`
  ).run(imdb, type, tmdb, Date.now());
}

it('resolves the imdb id at enqueue time from the cache', () => {
  seedMeta('tt0111161', 278, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 278, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)).toEqual([
    { tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161', removedAt: expect.any(Number) }
  ]);
});

it('maps a tv row to the series cache key, not the movie one', () => {
  // The cache is keyed (imdb_id, media_type) with 'series' for tv. Looking up 'tv' finds nothing
  // and would silently enqueue an unpushable row.
  seedMeta('tt0903747', 1396, 'series');
  enqueueHouseholdRemoval(db, { tmdbId: 1396, mediaType: 'tv' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBe('tt0903747');
});

it('does not confuse a movie and a series that share a tmdb id', () => {
  seedMeta('tt_movie', 42, 'movie');
  seedMeta('tt_series', 42, 'series');
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'tv' });
  const rows = listHouseholdRemovals(db).sort((a, b) => a.mediaType.localeCompare(b.mediaType));
  expect(rows.map((r) => [r.mediaType, r.imdbId])).toEqual([
    ['movie', 'tt_movie'], ['tv', 'tt_series']
  ]);
});

it('enqueues with a null imdb id when the cache cannot resolve it', () => {
  enqueueHouseholdRemoval(db, { tmdbId: 999, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBeNull();
});

it('resolves a Seerr-backfilled row even though Cinemeta had cached a miss', () => {
  // cinemeta.ts writes a miss as (tt_x, movie, tmdb_id NULL, found 0); stremio-sync.ts then
  // backfills tmdb_id onto that row from Seerr. The imdb id in it is real — it is the id pulse
  // pushed to Stremio — so a removal MUST be able to resolve and push it.
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt_seerr','movie',555,NULL,NULL,0,?)`
  ).run(Date.now());
  enqueueHouseholdRemoval(db, { tmdbId: 555, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBe('tt_seerr');
});

it('a pure Cinemeta negative cannot be resolved, because it has no tmdb id to match on', () => {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt_bogus','movie',NULL,NULL,NULL,0,?)`
  ).run(Date.now());
  enqueueHouseholdRemoval(db, { tmdbId: 777, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBeNull();
});

it('re-enqueuing the same title refreshes it rather than duplicating', () => {
  seedMeta('tt1', 1, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});

it('re-enqueuing refreshes the row rather than duplicating or keeping a stale null', () => {
  // First pass: cache is cold, so the row is enqueued unresolved.
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBeNull();
  const firstAt = listHouseholdRemovals(db)[0].removedAt;

  // Cache warms, viewer removes again. DO NOTHING would strand the null forever.
  seedMeta('tt1', 1, 'movie');
  vi.setSystemTime(new Date(firstAt + 5000));
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });

  const rows = listHouseholdRemovals(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].imdbId).toBe('tt1');
  expect(rows[0].removedAt).toBeGreaterThan(firstAt);
});

it('clears only the keys it is given', () => {
  seedMeta('tt1', 1, 'movie'); seedMeta('tt2', 2, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 2, mediaType: 'movie' });
  clearHouseholdRemovals(db, [{ tmdbId: 1, mediaType: 'movie' }]);
  expect(listHouseholdRemovals(db).map((r) => r.tmdbId)).toEqual([2]);
});

it('clears only the media type it is given, not both', () => {
  seedMeta('tt_movie', 42, 'movie');
  seedMeta('tt_series', 42, 'series');
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'tv' });
  clearHouseholdRemovals(db, [{ tmdbId: 42, mediaType: 'movie' }]);
  const rows = listHouseholdRemovals(db);
  expect(rows).toHaveLength(1);
  expect(rows[0].mediaType).toBe('tv');
});

it('clearing an empty list is a no-op that does not wipe the queue', () => {
  seedMeta('tt1', 1, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  clearHouseholdRemovals(db, []);
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});

it('clearing an empty list issues no DELETE at all', () => {
  seedMeta('tt1', 1, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  let deletes = 0;
  const orig = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('DELETE FROM household_removals')) deletes++;
    return orig(sql);
  }) as any);
  clearHouseholdRemovals(db, []);
  spy.mockRestore();
  expect(deletes).toBe(0);
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});
