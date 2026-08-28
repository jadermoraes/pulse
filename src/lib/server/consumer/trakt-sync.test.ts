import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { selectUnsynced, pollTraktHistory } from './trakt-sync';
import { saveCredential, getCredential, recordSuccess } from './spoke-credentials';
import type { TraktPlay } from '../integrations/trakt';

const movie: TraktPlay = {
  tmdbId: 278, imdbId: 'tt0111161', mediaType: 'movie', season: null, episode: null, watchedAt: 1000
};
const ep: TraktPlay = {
  tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 5, watchedAt: 2000
};

it('selectUnsynced drops plays Trakt already has, by either id', () => {
  expect(selectUnsynced(new Set(['imdb:tt0111161']), [movie])).toEqual([]);
  expect(selectUnsynced(new Set(['tmdb:278']), [movie])).toEqual([]);
  expect(selectUnsynced(new Set(['tmdb:1396:s2e5']), [ep])).toEqual([]);
  expect(selectUnsynced(new Set(), [movie, ep])).toHaveLength(2);
});

it('selectUnsynced keeps an episode whose show is watched but this episode is not', () => {
  expect(selectUnsynced(new Set(['tmdb:1396:s2e4']), [ep])).toEqual([ep]);
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  process.env.PULSE_TRAKT_CLIENT_ID = 'cid';
  process.env.PULSE_TRAKT_CLIENT_SECRET = 'csec';
  // id=1 is the Admin role auto-seeded by migrate(); use id=2 for the test role.
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)')
    .run('viewer', Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (1,2,'Jader','plex-1','active',?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,278,'tt0111161','movie',NULL,NULL,1000,'tautulli',1)`
  ).run();
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('pushes an unsynced play and records success', async () => {
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', refresh: 'rt', expiresAt: Date.now() + 60_000 });
  await pollTraktHistory(db);

  expect(calls).toContain('POST https://api.trakt.tv/sync/history');
  expect(getCredential(db, 1, 'trakt')?.lastSyncAt).not.toBeNull();
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(0);
});

it('a failing spoke records the failure and does not throw', async () => {
  global.fetch = (vi.fn(async () => new Response('nope', { status: 401 })) as any);
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });

  await expect(pollTraktHistory(db)).resolves.toBeUndefined();
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(1);
  expect(getCredential(db, 1, 'trakt')?.lastError).toBeTruthy();
});

it('five consecutive 5xx do NOT disable the credential (a Trakt outage is transient)', async () => {
  // fail_count never decays and the skip guard leaves lastSyncAt untouched on failure, so a
  // ten-minute Trakt outage is five ticks — enough to permanently disable a working link if
  // transient failures counted toward MAX_FAILS.
  global.fetch = (vi.fn(async () => new Response('boom', { status: 500 })) as any);
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });

  for (let i = 0; i < 5; i++) await pollTraktHistory(db);

  const cred = getCredential(db, 1, 'trakt');
  expect(cred?.enabled).toBe(true);
  expect(cred?.failCount).toBe(0);
  expect(cred?.lastError).toContain('500'); // still visible, just not fatal
});

it('a network error does not count toward MAX_FAILS either', async () => {
  global.fetch = (vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as any);
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });

  for (let i = 0; i < 5; i++) await pollTraktHistory(db);

  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(true);
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(0);
});

it('five consecutive 401s DO disable the credential (the token is genuinely dead)', async () => {
  global.fetch = (vi.fn(async () => new Response('unauthorized', { status: 401 })) as any);
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });

  for (let i = 0; i < 5; i++) await pollTraktHistory(db);

  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(false);
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(5);
});

it('surfaces a non-zero not_found count on the credential without failing the sync', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response(JSON.stringify({
      added: { movies: 0 }, not_found: { movies: [{ ids: { tmdb: 278 } }], shows: [], seasons: [], episodes: [] }
    }), { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });
  await pollTraktHistory(db);

  const cred = getCredential(db, 1, 'trakt');
  expect(cred?.enabled).toBe(true);
  expect(cred?.failCount).toBe(0);
  expect(cred?.lastSyncAt).not.toBeNull();     // the sync itself succeeded
  expect(cred?.lastError).toContain('not found'); // ...but the unresolvable play is visible
});

it('does nothing at all when Trakt is not configured', async () => {
  delete process.env.PULSE_TRAKT_CLIENT_ID;
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  global.fetch = fetchSpy as any;

  // An expired token would otherwise hit /oauth/token with an empty client_id, take a 401,
  // and five ticks later disable a credential that is perfectly fine.
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', refresh: 'rt', expiresAt: Date.now() - 1000 });
  await pollTraktHistory(db);

  expect(fetchSpy).not.toHaveBeenCalled();
  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(true);
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(0);
});

it('refreshes an expired token before syncing', async () => {
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    urls.push(String(url));
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 7200 }), { status: 200 });
    }
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'old', refresh: 'rt', expiresAt: Date.now() - 1000 });
  await pollTraktHistory(db);

  expect(urls.some((u) => u.includes('/oauth/token'))).toBe(true);
  expect(getCredential(db, 1, 'trakt')?.secret).toBe('a2');
});

it('skips a consumer with nothing new since lastSyncAt: no fetch at all', async () => {
  const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
  global.fetch = fetchSpy as any;

  // The only stored play is at watched_at=1000 (seeded in beforeEach). Recording a success now
  // sets lastSyncAt to "now", well after that play, so there is nothing new to push.
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', refresh: 'rt', expiresAt: Date.now() + 60_000 });
  recordSuccess(db, 1, 'trakt');

  await pollTraktHistory(db);

  expect(fetchSpy).not.toHaveBeenCalled();
});

it('excludes a TV play with a null season/episode: never selected, never posted', async () => {
  db.prepare('DELETE FROM watch_plays').run();
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,1396,NULL,'tv',NULL,NULL,3000,'tautulli',2)`
  ).run();

  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', refresh: 'rt', expiresAt: Date.now() + 60_000 });
  await pollTraktHistory(db);

  expect(calls).toEqual([]);
  expect(getCredential(db, 1, 'trakt')?.lastSyncAt).not.toBeNull();
});

