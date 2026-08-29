import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  parseJellystatRows, resolveJellyfinItems, ingestJellystatPlays, COMPLETION_RATIO
} from './jellystat-ingest';
import type { Connection } from '../connections';

const jellystatConn: Connection = {
  id: 1, type: 'jellystat', name: 'Jellystat', baseUrl: 'http://jellystat:3000',
  secret: 'jskey', options: {}, enabled: true
};
const jellyfinConn: Connection = {
  id: 2, type: 'jellyfin', name: 'Jellyfin', baseUrl: 'http://jellyfin:8096',
  secret: 'jfkey', options: {}, enabled: true
};

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  // migrate() auto-seeds an Admin role at id=1, so the viewer role here must take a fresh id.
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)')
    .run('viewer', Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
     VALUES (1,2,'Jader','jf-1','active',?)`
  ).run(Date.now());
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function history(rows: any[]) {
  return new Response(JSON.stringify(rows), { status: 200 });
}
function items(list: any[]) {
  return new Response(JSON.stringify({ Items: list }), { status: 200 });
}

it('parseJellystatRows maps a movie row and an episode row, converts to ms, tolerates both envelopes', () => {
  const raw = [
    { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
      SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
      ActivityDateInserted: '2026-06-21T19:01:52.188Z' },
    { Id: 'act-2', UserId: 'jf-1', NowPlayingItemId: 'series-1', EpisodeId: 'ep-1',
      SeasonNumber: 1, EpisodeNumber: 2, PlaybackDuration: 200,
      ActivityDateInserted: '2026-06-21T20:00:00.000Z' }
  ];

  const fromArray = parseJellystatRows(raw);
  expect(fromArray).toHaveLength(2);
  expect(fromArray[0]).toMatchObject({
    activityId: 'act-1', jellyfinUserId: 'jf-1', itemId: 'movie-1', episodeId: null,
    season: null, episode: null, playbackSeconds: 100,
    watchedAt: Date.parse('2026-06-21T19:01:52.188Z')
  });
  expect(fromArray[1]).toMatchObject({
    activityId: 'act-2', jellyfinUserId: 'jf-1', itemId: 'series-1', episodeId: 'ep-1',
    season: 1, episode: 2, playbackSeconds: 200,
    watchedAt: Date.parse('2026-06-21T20:00:00.000Z')
  });

  const fromEnvelope = parseJellystatRows({ results: raw });
  expect(fromEnvelope).toEqual(fromArray);
});

it('routes each activity to the consumer that owns that jellyfin user id (not merely two rows)', async () => {
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
     VALUES (2,2,'Bianca','jf-2','active',?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' },
        { Id: 'act-2', UserId: 'jf-2', NowPlayingItemId: 'movie-2', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:01:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-1', Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '111' }, RunTimeTicks: 1_000_000_000 },
        { Id: 'movie-2', Type: 'Movie', ProviderIds: { Imdb: 'tt2', Tmdb: '222' }, RunTimeTicks: 1_000_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(2);
  const rows = db.prepare('SELECT consumer_id, tmdb_id FROM watch_plays ORDER BY tmdb_id').all() as any[];
  expect(rows).toEqual([
    { consumer_id: 1, tmdb_id: 111 }, // Jader / jf-1
    { consumer_id: 2, tmdb_id: 222 }  // Bianca / jf-2
  ]);
});

it('a blank or NULL jellyfin_user_id never matches a row with an empty/absent UserId', async () => {
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
     VALUES (2,2,'Blank','','active',?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
     VALUES (3,2,'Unlinked',NULL,'active',?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: '', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' },
        { Id: 'act-2', NowPlayingItemId: 'movie-2', EpisodeId: null, // no UserId key at all
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:01:00.000Z' }
      ]);
    }
    throw new Error(`unexpected call: ${u}`); // /Items must never be reached
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('completion: 10s of a 2815s episode is skipped, 95% is ingested, and zero/missing runtime is skipped', async () => {
  const episodeRuntimeTicks = 2815 * 10_000_000; // 2815 seconds

  async function run(playbackSeconds: number, episodeItem: any) {
    db = openDb(':memory:'); migrate(db);
    db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
    db.prepare(
      `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
       VALUES (1,2,'Jader','jf-1','active',?)`
    ).run(Date.now());

    global.fetch = (vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/getHistory')) {
        return history([
          { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'series-1', EpisodeId: 'ep-1',
            SeasonNumber: 1, EpisodeNumber: 1, PlaybackDuration: playbackSeconds,
            ActivityDateInserted: '2026-06-21T19:01:52.188Z' }
        ]);
      }
      if (u.includes('/Items')) {
        return items([
          { Id: 'series-1', Type: 'Series', ProviderIds: { Imdb: 'tt30460310', Tmdb: '220102' }, RunTimeTicks: 0 },
          episodeItem
        ]);
      }
      throw new Error(`unexpected call: ${u}`);
    }) as any);

    return ingestJellystatPlays(db, jellystatConn, jellyfinConn);
  }

  expect(await run(10, { Id: 'ep-1', Type: 'Episode', ProviderIds: { Imdb: 'tt31632368' }, RunTimeTicks: episodeRuntimeTicks })).toBe(0);
  expect(await run(Math.ceil(2815 * 0.95), { Id: 'ep-1', Type: 'Episode', ProviderIds: { Imdb: 'tt31632368' }, RunTimeTicks: episodeRuntimeTicks })).toBe(1);
  expect(await run(2000, { Id: 'ep-1', Type: 'Episode', ProviderIds: { Imdb: 'tt31632368' }, RunTimeTicks: 0 })).toBe(0);
});

it('episode rows carry the SERIES tmdb/imdb ids, and completion uses the EPISODE\'s runtime', async () => {
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'series-1', EpisodeId: 'ep-1',
          SeasonNumber: 1, EpisodeNumber: 1, PlaybackDuration: 2800,
          ActivityDateInserted: '2026-06-21T19:01:52.188Z' }
      ]);
    }
    if (u.includes('/Items')) {
      expect(u).toContain('series-1');
      expect(u).toContain('ep-1');
      return items([
        { Id: 'series-1', Type: 'Series', ProviderIds: { Imdb: 'tt30460310', Tmdb: '220102', Tvdb: '450033' }, RunTimeTicks: 0 },
        { Id: 'ep-1', Type: 'Episode', ProviderIds: { Imdb: 'tt31632368', Tvdb: '10494663' }, RunTimeTicks: 2815 * 10_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  });
  global.fetch = fetchMock as any;

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1);
  const row = db.prepare('SELECT * FROM watch_plays').get() as any;
  expect(row).toMatchObject({
    consumer_id: 1, tmdb_id: 220102, imdb_id: 'tt30460310', // the SERIES's ids, not the episode's
    media_type: 'tv', season: 1, episode: 1, source: 'jellystat', source_row: 'act-1'
  });

  const itemsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/Items'));
  expect(itemsCalls).toHaveLength(1); // one batched call for both ids
});

it('resolveJellyfinItems caches items permanently: a second ingest for the same item makes no second /Items fetch', async () => {
  let historyCalls = 0;
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      // Called twice with the poller advancing between calls: same item, a new activity each time.
      const ts = historyCalls === 0 ? '2026-06-21T19:00:00.000Z' : '2026-06-21T19:05:00.000Z';
      const id = historyCalls === 0 ? 'act-1' : 'act-2';
      historyCalls++;
      return history([
        { Id: id, UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: ts }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-1', Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '111' }, RunTimeTicks: 1_000_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  });
  global.fetch = fetchMock as any;

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1);
  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1);

  const itemsCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/Items'));
  expect(itemsCalls).toHaveLength(1); // second ingest served the item entirely from cache
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 2 });
});

it('ingesting the same activity UUID twice inserts one row', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-1', Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '111' }, RunTimeTicks: 1_000_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1);
  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 1 });
});

it('whitelist: a resolved item type of Audio is not ingested', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'track-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'track-1', Type: 'Audio', ProviderIds: {}, RunTimeTicks: 200_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('a TV row with a null season or episode is not ingested', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'series-1', EpisodeId: 'ep-1',
          SeasonNumber: null, EpisodeNumber: 1, PlaybackDuration: 2800,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' },
        { Id: 'act-2', UserId: 'jf-1', NowPlayingItemId: 'series-1', EpisodeId: 'ep-2',
          SeasonNumber: 1, EpisodeNumber: null, PlaybackDuration: 2800,
          ActivityDateInserted: '2026-06-21T19:01:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'series-1', Type: 'Series', ProviderIds: { Imdb: 'tt1', Tmdb: '1' }, RunTimeTicks: 0 },
        { Id: 'ep-1', Type: 'Episode', ProviderIds: {}, RunTimeTicks: 2815 * 10_000_000 },
        { Id: 'ep-2', Type: 'Episode', ProviderIds: {}, RunTimeTicks: 2815 * 10_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('resolveJellyfinItems batches only the missing ids and caches results permanently', async () => {
  const fetchMock = vi.fn(async () => items([
    { Id: 'movie-1', Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '111' }, RunTimeTicks: 1_000_000_000 },
    { Id: 'series-1', Type: 'Series', ProviderIds: { Imdb: 'tt2', Tmdb: '222' }, RunTimeTicks: 0 }
  ]));
  global.fetch = fetchMock as any;

  const first = await resolveJellyfinItems(db, jellyfinConn, ['movie-1', 'series-1']);
  expect(first.get('movie-1')).toMatchObject({ itemType: 'Movie', tmdbId: 111, imdbId: 'tt1', runtimeSeconds: 100 });
  expect(first.get('series-1')).toMatchObject({ itemType: 'Series', tmdbId: 222, imdbId: 'tt2', runtimeSeconds: 0 });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const second = await resolveJellyfinItems(db, jellyfinConn, ['movie-1', 'series-1']);
  expect(second.get('movie-1')).toMatchObject({ itemType: 'Movie', tmdbId: 111 });
  expect(fetchMock).toHaveBeenCalledTimes(1); // still 1: both ids served from cache

  const cached = db.prepare('SELECT * FROM jellyfin_item_cache WHERE item_id=?').get('movie-1') as any;
  expect(cached).toMatchObject({ item_type: 'Movie', tmdb_id: 111, imdb_id: 'tt1', runtime_seconds: 100 });
});

it('exposes COMPLETION_RATIO as 0.9', () => {
  expect(COMPLETION_RATIO).toBe(0.9);
});

// --- Fix-round tests (review findings) ---------------------------------------------------

it('an activity started EARLIER than an already-ingested one is still ingested (no watermark on start time)', async () => {
  // ActivityDateInserted is a session's START time, not its completion time. A cursor on it
  // would let an overlapping-but-later-finishing session get skipped forever once a
  // later-starting/earlier-finishing session moves the "watermark" past it.
  let call = 0;
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      call++;
      if (call === 1) {
        // First poll: only the later-starting, quickly-finished activity has completed so far.
        return history([
          { Id: 'act-later', UserId: 'jf-1', NowPlayingItemId: 'movie-later', EpisodeId: null,
            SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
            ActivityDateInserted: '2026-06-21T19:05:00.000Z' }
        ]);
      }
      // Second poll: the earlier-starting activity has now finished too. Jellystat still
      // reports its original (earlier) start time.
      return history([
        { Id: 'act-later', UserId: 'jf-1', NowPlayingItemId: 'movie-later', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:05:00.000Z' },
        { Id: 'act-earlier', UserId: 'jf-1', NowPlayingItemId: 'movie-earlier', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' } // earlier than act-later's timestamp
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-later', Type: 'Movie', ProviderIds: { Imdb: 'tt-later', Tmdb: '1' }, RunTimeTicks: 1_000_000_000 },
        { Id: 'movie-earlier', Type: 'Movie', ProviderIds: { Imdb: 'tt-earlier', Tmdb: '2' }, RunTimeTicks: 1_000_000_000 }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1);
  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(1); // act-earlier must still land
  const rows = db.prepare('SELECT source_row FROM watch_plays ORDER BY source_row').all() as any[];
  expect(rows.map((r) => r.source_row).sort()).toEqual(['act-earlier', 'act-later']);
});

it('an item with empty ProviderIds (no tmdb/imdb id at all) is not ingested', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 100,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-1', Type: 'Movie', ProviderIds: {}, RunTimeTicks: 1_000_000_000 } // unmatched file / home video
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  expect(await ingestJellystatPlays(db, jellystatConn, jellyfinConn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('two consumers cannot share a jellyfin_user_id (partial unique index, mirroring idx_consumer_plex)', () => {
  expect(() => {
    db.prepare(
      `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
       VALUES (2,2,'Duplicate','jf-1','active',?)` // 'jf-1' already belongs to consumer 1
    ).run(Date.now());
  }).toThrow();

  // Blank/NULL ids are exempt (mean "not linked"), same as the Plex index.
  expect(() => {
    db.prepare(
      `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
       VALUES (3,2,'BlankA','','active',?)`
    ).run(Date.now());
    db.prepare(
      `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
       VALUES (4,2,'BlankB','','active',?)`
    ).run(Date.now());
    db.prepare(
      `INSERT INTO consumer_users(id,role_id,display_name,jellyfin_user_id,status,created_at)
       VALUES (5,2,'NullA',NULL,'active',?)`
    ).run(Date.now());
  }).not.toThrow();
});

it('tolerates an explicit null RunTimeTicks or provider id value without aborting the ingest', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('/api/getHistory')) {
      return history([
        { Id: 'act-1', UserId: 'jf-1', NowPlayingItemId: 'movie-1', EpisodeId: null,
          SeasonNumber: null, EpisodeNumber: null, PlaybackDuration: 2000,
          ActivityDateInserted: '2026-06-21T19:00:00.000Z' }
      ]);
    }
    if (u.includes('/Items')) {
      return items([
        { Id: 'movie-1', Type: 'Movie', ProviderIds: { Imdb: null, Tmdb: '111' }, RunTimeTicks: null }
      ]);
    }
    throw new Error(`unexpected call: ${u}`);
  }) as any);

  // Must not throw despite the nulls; skipped only because runtime is unknown (never assume finished).
  await expect(ingestJellystatPlays(db, jellystatConn, jellyfinConn)).resolves.toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('negatively caches an id Jellyfin never returns, so it is not re-fetched on the next resolve', async () => {
  const fetchMock = vi.fn(async () => items([
    { Id: 'movie-exists', Type: 'Movie', ProviderIds: { Imdb: 'tt1', Tmdb: '1' }, RunTimeTicks: 1_000_000_000 }
    // 'movie-deleted' is deliberately absent from the response
  ]));
  global.fetch = fetchMock as any;

  const first = await resolveJellyfinItems(db, jellyfinConn, ['movie-exists', 'movie-deleted']);
  expect(first.get('movie-deleted')).toMatchObject({ itemType: null, tmdbId: null, imdbId: null, runtimeSeconds: null });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const second = await resolveJellyfinItems(db, jellyfinConn, ['movie-exists', 'movie-deleted']);
  expect(second.get('movie-deleted')).toMatchObject({ itemType: null });
  expect(fetchMock).toHaveBeenCalledTimes(1); // the negative cache entry served 'movie-deleted' too

  const cached = db.prepare('SELECT * FROM jellyfin_item_cache WHERE item_id=?').get('movie-deleted') as any;
  expect(cached).toMatchObject({ item_type: null, tmdb_id: null, imdb_id: null, runtime_seconds: null });
});

it('chunks /Items requests at 100 ids per call', async () => {
  const ids = Array.from({ length: 150 }, (_, i) => `item-${i}`);
  const fetchMock = vi.fn(async (url: any) => {
    const u = new URL(String(url));
    const requested = (u.searchParams.get('ids') ?? '').split(',');
    return items(requested.map((id) => ({
      Id: id, Type: 'Movie', ProviderIds: { Imdb: `tt-${id}`, Tmdb: '1' }, RunTimeTicks: 1_000_000_000
    })));
  });
  global.fetch = fetchMock as any;

  const result = await resolveJellyfinItems(db, jellyfinConn, ids);
  expect(fetchMock).toHaveBeenCalledTimes(2); // 150 ids -> two batches of <=100
  const sizes = fetchMock.mock.calls.map(([url]) => {
    const u = new URL(String(url));
    return (u.searchParams.get('ids') ?? '').split(',').length;
  });
  expect(sizes.sort((a, b) => a - b)).toEqual([50, 100]);
  expect(result.size).toBe(150);
});
