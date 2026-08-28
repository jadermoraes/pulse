import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { parseHistoryRows, resolveIds, ingestPlays, highestSourceRow } from './plays-ingest';
import type { Connection } from '../connections';

const conn: Connection = {
  id: 1, type: 'tautulli', name: 'Tautulli', baseUrl: 'http://tautulli:8181',
  secret: 'key', options: {}, enabled: true
};

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  // migrate() auto-seeds an Admin role at id=1, so the viewer role here must take a fresh id.
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)')
    .run('viewer', Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (1,2,'Jader','plex-1','active',?)`
  ).run(Date.now());
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('parseHistoryRows keeps only finished plays and maps season/episode', () => {
  const rows = parseHistoryRows({
    response: { result: 'success', data: { data: [
      { row_id: 7, rating_key: '900', grandparent_rating_key: '800', user_id: 'plex-1',
        media_type: 'episode', watched_status: 1, stopped: 1700,
        parent_media_index: '2', media_index: '5' },
      { row_id: 8, rating_key: '901', user_id: 'plex-1', media_type: 'movie',
        watched_status: 0, stopped: 1800, parent_media_index: null, media_index: null }
    ] } }
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    rowId: 7, ratingKey: '900', grandparentRatingKey: '800', season: 2, episode: 5
  });
});

it('parseHistoryRows normalises an absent grandparent_rating_key to null (movies)', () => {
  const rows = parseHistoryRows({
    response: { result: 'success', data: { data: [
      { row_id: 8, rating_key: '901', user_id: 'plex-1', media_type: 'movie',
        watched_status: 1, stopped: 1800, parent_media_index: null, media_index: null }
    ] } }
  });
  expect(rows[0]).toMatchObject({ grandparentRatingKey: null });
});

it('resolveIds reads guids from get_metadata and caches them', async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify({
    response: { result: 'success', data: { guids: ['imdb://tt0111161', 'tmdb://278'] } }
  }), { status: 200 }));
  global.fetch = spy as any;

  expect(await resolveIds(db, conn, '900')).toEqual({ tmdbId: 278, imdbId: 'tt0111161' });
  expect(await resolveIds(db, conn, '900')).toEqual({ tmdbId: 278, imdbId: 'tt0111161' });
  expect(spy).toHaveBeenCalledTimes(1); // second call served from plex_guid_cache
});

it('ingestPlays skips plays whose plex user matches no consumer', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 1, rating_key: '900', user_id: 'someone-else', media_type: 'movie',
          watched_status: 1, stopped: 1700, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['imdb://tt1', 'tmdb://1'] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('ingestPlays inserts once and is idempotent on re-run', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 5, rating_key: '900', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1700, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['imdb://tt0111161', 'tmdb://278'] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(1);
  expect(await ingestPlays(db, conn)).toBe(0);
  const row = db.prepare('SELECT * FROM watch_plays').get() as any;
  expect(row).toMatchObject({
    consumer_id: 1, tmdb_id: 278, imdb_id: 'tt0111161',
    media_type: 'movie', watched_at: 1700 * 1000, source: 'tautulli', source_row: 5
  });
  expect(highestSourceRow(db, 'tautulli')).toBe(5);
});

it('parseHistoryRows drops media types other than movie/episode (e.g. music tracks)', () => {
  const rows = parseHistoryRows({
    response: { result: 'success', data: { data: [
      { row_id: 9, rating_key: '902', user_id: 'plex-1', media_type: 'track',
        watched_status: 1, stopped: 1700, parent_media_index: null, media_index: null }
    ] } }
  });
  expect(rows).toHaveLength(0);
});

it('resolveIds does not cache a Tautulli error envelope, and retries on the next call', async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify({
    response: { result: 'error', message: 'boom', data: {} }
  }), { status: 200 }));
  global.fetch = spy as any;

  await expect(resolveIds(db, conn, '900')).rejects.toThrow('Tautulli error');
  expect(db.prepare('SELECT * FROM plex_guid_cache WHERE rating_key=?').get('900')).toBeUndefined();

  await expect(resolveIds(db, conn, '900')).rejects.toThrow('Tautulli error');
  expect(spy).toHaveBeenCalledTimes(2); // no cache row was written by the failed call, so it retries
});

it('ingestPlays pages backward through history when the gap since the cursor exceeds one page', async () => {
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,1,'tt1','movie',NULL,NULL,1000,'tautulli',2)`
  ).run();

  const fetchMock = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.searchParams.get('cmd') === 'get_history') {
      const start = Number(u.searchParams.get('start') ?? '0');
      const page0 = [
        { row_id: 5, rating_key: '905', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1705, parent_media_index: null, media_index: null },
        { row_id: 4, rating_key: '904', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1704, parent_media_index: null, media_index: null }
      ];
      const page1 = [
        { row_id: 3, rating_key: '903', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1703, parent_media_index: null, media_index: null },
        { row_id: 2, rating_key: '902', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1702, parent_media_index: null, media_index: null }
      ];
      const data = start === 0 ? page0 : page1;
      return new Response(JSON.stringify({ response: { result: 'success', data: { data } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['tmdb://1'] } }
    }), { status: 200 });
  });
  global.fetch = fetchMock as any;

  expect(await ingestPlays(db, conn, { pageSize: 2 })).toBe(3);
  const rows = db.prepare('SELECT source_row FROM watch_plays ORDER BY source_row').all() as any[];
  expect(rows.map((r) => r.source_row)).toEqual([2, 3, 4, 5]);

  const historyCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('get_history'));
  expect(historyCalls).toHaveLength(2); // both pages were fetched to close the gap
});

it('ingestPlays does not walk full server history when the cursor is empty (backfill is out of scope)', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 50, rating_key: '950', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1750, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['tmdb://5'] } }
    }), { status: 200 });
  });
  global.fetch = fetchMock as any;

  expect(await ingestPlays(db, conn)).toBe(1);
  const historyCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('get_history'));
  expect(historyCalls).toHaveLength(1); // only the newest page, no historical paging
});

it('ingestPlays keeps paging past a raw page that filters down to zero rows (all tracks/unfinished)', async () => {
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,1,'tt1','movie',NULL,NULL,1000,'tautulli',2)`
  ).run();

  const fetchMock = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.searchParams.get('cmd') === 'get_history') {
      const start = Number(u.searchParams.get('start') ?? '0');
      // page0 (start=0): a full raw page, but every row is filtered out by parseHistoryRows
      // (one is a music track, one is an unfinished play) — its FILTERED length is 0, even
      // though the RAW page is full and older genuine history still sits behind it.
      const page0 = [
        { row_id: 6, rating_key: '906', user_id: 'plex-1', media_type: 'track',
          watched_status: 1, stopped: 1706, parent_media_index: null, media_index: null },
        { row_id: 5, rating_key: '905', user_id: 'plex-1', media_type: 'movie',
          watched_status: 0, stopped: 1705, parent_media_index: null, media_index: null }
      ];
      // page1 (start=2): the genuine finished movie row that must still be reached.
      const page1 = [
        { row_id: 4, rating_key: '904', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1704, parent_media_index: null, media_index: null },
        { row_id: 3, rating_key: '903', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1703, parent_media_index: null, media_index: null }
      ];
      // Beyond page1, the server has no more history — an empty raw page is the real stop signal.
      const data = start === 0 ? page0 : start === 2 ? page1 : [];
      return new Response(JSON.stringify({ response: { result: 'success', data: { data } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['tmdb://1'] } }
    }), { status: 200 });
  });
  global.fetch = fetchMock as any;

  expect(await ingestPlays(db, conn, { pageSize: 2 })).toBe(2);
  const rows = db.prepare('SELECT source_row FROM watch_plays ORDER BY source_row').all() as any[];
  expect(rows.map((r) => r.source_row)).toEqual([2, 3, 4]);

  // Without the fix, the loop stops right after the all-filtered page0 (filtered length 0),
  // never reaching page1 where rows 4 and 3 actually live.
  const historyCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('get_history'));
  expect(historyCalls).toHaveLength(3); // page0 (filtered empty, raw full) -> page1 -> empty page confirms exhaustion
});

it('ingestPlays resolves an episode from the SHOW rating key (grandparent), not the episode\'s own key', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.searchParams.get('cmd') === 'get_history') {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 1, rating_key: '900', grandparent_rating_key: '800', user_id: 'plex-1',
          media_type: 'episode', watched_status: 1, stopped: 1700,
          parent_media_index: '2', media_index: '5' }
      ] } } }), { status: 200 });
    }
    if (u.searchParams.get('cmd') === 'get_metadata') {
      expect(u.searchParams.get('rating_key')).toBe('800'); // the SHOW's key, not the episode's
      return new Response(JSON.stringify({
        response: { result: 'success', data: { guids: ['imdb://tt9999999', 'tmdb://5555'] } }
      }), { status: 200 });
    }
    throw new Error(`unexpected call: ${url}`);
  });
  global.fetch = fetchMock as any;

  expect(await ingestPlays(db, conn)).toBe(1);
  const row = db.prepare('SELECT * FROM watch_plays').get() as any;
  expect(row).toMatchObject({
    consumer_id: 1, tmdb_id: 5555, imdb_id: 'tt9999999', // the SHOW's ids
    media_type: 'tv', season: 2, episode: 5, source_row: 1
  });

  const cached = db.prepare('SELECT * FROM plex_guid_cache WHERE rating_key=?').get('800') as any;
  expect(cached).toMatchObject({ tmdb_id: 5555, imdb_id: 'tt9999999' });
  expect(db.prepare('SELECT * FROM plex_guid_cache WHERE rating_key=?').get('900')).toBeUndefined();
});

it('ingestPlays skips an episode row with no usable grandparent_rating_key', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 1, rating_key: '900', user_id: 'plex-1', media_type: 'episode',
          watched_status: 1, stopped: 1700, parent_media_index: '2', media_index: '5' }
        // no grandparent_rating_key at all
      ] } } }), { status: 200 });
    }
    throw new Error(`unexpected call: ${url}`); // get_metadata must never be reached
  });
  global.fetch = fetchMock as any;

  expect(await ingestPlays(db, conn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('routes each history row to the consumer that owns that plex account', async () => {
  // The highest-consequence failure in this feature is mis-attribution: a row landing under the
  // wrong consumer publishes someone else\'s viewing to a viewer\'s public Trakt profile.
  // Asserting "two rows were inserted" would pass even if both landed on the same consumer.
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (2,2,'Bianca','plex-2','active',?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.searchParams.get('cmd') === 'get_history') {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 11, rating_key: '911', user_id: 'plex-2', media_type: 'movie',
          watched_status: 1, stopped: 1711, parent_media_index: null, media_index: null },
        { row_id: 10, rating_key: '910', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1710, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    // Distinct ids per rating_key so a swapped row is impossible to miss.
    const key = u.searchParams.get('rating_key');
    const tmdb = key === '910' ? 910 : 911;
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: [`tmdb://${tmdb}`] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(2);
  const rows = db.prepare('SELECT consumer_id, tmdb_id, source_row FROM watch_plays ORDER BY source_row')
    .all() as any[];
  expect(rows).toEqual([
    { consumer_id: 1, tmdb_id: 910, source_row: 10 }, // Jader / plex-1
    { consumer_id: 2, tmdb_id: 911, source_row: 11 }  // Bianca / plex-2
  ]);
});

it('a blank or NULL plex_account_id never matches a row with an empty/absent user_id', async () => {
  // Otherwise every unattributed Tautulli row (Plex omits user_id on some rows) would be
  // published to whichever consumer happened to have an unset plex_account_id.
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (2,2,'Blank','','active',?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (3,2,'Unlinked',NULL,'active',?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 20, rating_key: '920', user_id: '', media_type: 'movie',
          watched_status: 1, stopped: 1720, parent_media_index: null, media_index: null },
        { row_id: 21, rating_key: '921', media_type: 'movie',  // no user_id key at all
          watched_status: 1, stopped: 1721, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['tmdb://1'] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('asks Tautulli for history newest-first explicitly, on every page', async () => {
  // Every row_id comparison in fetchHistorySince assumes newest-first. Relying on Tautulli\'s
  // default means a change there would silently stop ingestion instead of failing loudly.
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,1,'tt1','movie',NULL,NULL,1000,'tautulli',2)`
  ).run();

  const fetchMock = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    if (u.searchParams.get('cmd') === 'get_history') {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 3, rating_key: '903', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1703, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['tmdb://1'] } }
    }), { status: 200 });
  });
  global.fetch = fetchMock as any;

  await ingestPlays(db, conn, { pageSize: 1 });
  const historyUrls = fetchMock.mock.calls
    .map(([url]) => new URL(String(url)))
    .filter((u) => u.searchParams.get('cmd') === 'get_history');
  expect(historyUrls.length).toBeGreaterThan(0);
  for (const u of historyUrls) {
    expect(u.searchParams.get('order_column')).toBe('date');
    expect(u.searchParams.get('order_dir')).toBe('desc');
  }
});
