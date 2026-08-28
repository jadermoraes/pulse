import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  requestDeviceCode, pollDeviceToken, refreshToken, traktConfigured,
  getWatchedIds, addToHistory, playKey, TraktHttpError, type TraktPlay
} from './trakt';

const realFetch = global.fetch;
beforeEach(() => {
  process.env.PULSE_TRAKT_CLIENT_ID = 'cid';
  process.env.PULSE_TRAKT_CLIENT_SECRET = 'csec';
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  }));
  global.fetch = spy as any;
  return spy;
}

it('traktConfigured is false without env', () => {
  delete process.env.PULSE_TRAKT_CLIENT_ID;
  expect(traktConfigured()).toBe(false);
});

it('requestDeviceCode maps the Trakt payload and sends the client id', async () => {
  const spy = mockFetch(200, {
    device_code: 'dc', user_code: 'ABC123',
    verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5
  });
  const r = await requestDeviceCode();
  expect(r).toEqual({
    deviceCode: 'dc', userCode: 'ABC123',
    verificationUrl: 'https://trakt.tv/activate', expiresIn: 600, interval: 5
  });
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/oauth/device/code');
  expect(JSON.parse(init.body)).toEqual({ client_id: 'cid' });
});

it('pollDeviceToken returns pending on 400', async () => {
  mockFetch(400, {});
  expect(await pollDeviceToken('dc')).toEqual({ status: 'pending' });
});

it('pollDeviceToken returns expired on 410', async () => {
  mockFetch(410, {});
  expect(await pollDeviceToken('dc')).toEqual({ status: 'expired' });
});

it('pollDeviceToken maps a successful token exchange', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  mockFetch(200, {
    access_token: 'at', refresh_token: 'rt', expires_in: 7200
  });
  const r = await pollDeviceToken('dc');
  expect(r).toEqual({
    status: 'ok', accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + 7200 * 1000
  });
  vi.useRealTimers();
});

it('a malformed token response is rejected rather than returned', async () => {
  mockFetch(200, { access_token: 'at' }); // no refresh_token / expires_in
  await expect(pollDeviceToken('dc')).rejects.toThrow();
});

it('refreshToken posts the refresh grant', async () => {
  const spy = mockFetch(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 });
  await refreshToken('r1');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/oauth/token');
  expect(JSON.parse(init.body)).toMatchObject({
    refresh_token: 'r1', client_id: 'cid', client_secret: 'csec', grant_type: 'refresh_token'
  });
});

it('getWatchedIds indexes movies by imdb and tmdb', async () => {
  mockFetch(200, [
    { movie: { ids: { imdb: 'tt0111161', tmdb: 278 } } },
    { movie: { ids: { imdb: null, tmdb: 999 } } }
  ]);
  const ids = await getWatchedIds('at', 'movies');
  expect(ids.has('imdb:tt0111161')).toBe(true);
  expect(ids.has('tmdb:278')).toBe(true);
  expect(ids.has('tmdb:999')).toBe(true);
});

it('getWatchedIds indexes episodes by season and number', async () => {
  mockFetch(200, [
    { show: { ids: { tmdb: 1396 } }, seasons: [
      { number: 2, episodes: [{ number: 5 }, { number: 6 }] }
    ] }
  ]);
  const ids = await getWatchedIds('at', 'shows');
  expect(ids.has('tmdb:1396:s2e5')).toBe(true);
  expect(ids.has('tmdb:1396:s2e6')).toBe(true);
  expect(ids.has('tmdb:1396:s2e7')).toBe(false);
});

it('addToHistory nests tv plays under the show, and keeps movies flat', async () => {
  const spy = mockFetch(201, { added: { movies: 1, episodes: 2 } });
  await addToHistory('at', [
    { tmdbId: 278, imdbId: 'tt0111161', mediaType: 'movie', season: null, episode: null, watchedAt: 1_000_000 },
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 5, watchedAt: 2_000_000 },
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 6, watchedAt: 3_000_000 }
  ]);
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/sync/history');
  const body = JSON.parse(init.body);
  expect(body.movies).toEqual([
    { watched_at: new Date(1_000_000).toISOString(), ids: { imdb: 'tt0111161', tmdb: 278 } }
  ]);
  // Both episodes collapse into ONE show entry, one season, two episodes.
  expect(body.shows).toEqual([
    {
      ids: { tmdb: 1396 },
      seasons: [
        {
          number: 2,
          episodes: [
            { number: 5, watched_at: new Date(2_000_000).toISOString() },
            { number: 6, watched_at: new Date(3_000_000).toISOString() }
          ]
        }
      ]
    }
  ]);
  expect(body.episodes).toBeUndefined();
  expect(init.headers.Authorization).toBe('Bearer at');
});

it('addToHistory skips a tv play with no season/episode rather than mis-posting it', async () => {
  const spy = mockFetch(201, {});
  await addToHistory('at', [
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: null, episode: null, watchedAt: 2_000_000 }
  ]);
  const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
  expect(body.shows).toEqual([]);
  expect(body.movies).toEqual([]);
});

it('addToHistory does nothing when given no plays', async () => {
  const spy = mockFetch(201, {});
  await addToHistory('at', []);
  expect(spy).not.toHaveBeenCalled();
});

it('getWatchedIds throws on a malformed response rather than returning an empty set', async () => {
  // An empty set is the dangerous answer here: `selectUnsynced` would then consider nothing
  // synced and re-POST the consumer's entire stored history to their public Trakt profile.
  mockFetch(200, [{ film: { ids: { imdb: 'tt0111161' } } }]); // "movie" renamed
  await expect(getWatchedIds('at', 'movies')).rejects.toThrow();

  mockFetch(200, [{ show: { ids: { tmdb: 1396 } } }]); // no `seasons` at all
  await expect(getWatchedIds('at', 'shows')).rejects.toThrow();

  mockFetch(200, { shows: [] }); // not an array
  await expect(getWatchedIds('at', 'shows')).rejects.toThrow();
});

it('getWatchedIds parses an empty history to an empty set', async () => {
  mockFetch(200, []);
  expect((await getWatchedIds('at', 'movies')).size).toBe(0);
  mockFetch(200, []);
  expect((await getWatchedIds('at', 'shows')).size).toBe(0);
});

it('getWatchedIds tolerates the extra fields Trakt actually sends', async () => {
  mockFetch(200, [{
    plays: 3, last_watched_at: '2026-01-01T00:00:00.000Z',
    show: { title: 'Breaking Bad', year: 2008, ids: { trakt: 1, slug: 'breaking-bad', tvdb: 81189, imdb: 'tt0903747', tmdb: 1396 } },
    seasons: [{ number: 2, episodes: [{ number: 5, plays: 1, last_watched_at: '2026-01-01T00:00:00.000Z' }] }]
  }]);
  const ids = await getWatchedIds('at', 'shows');
  expect(ids.has('tmdb:1396:s2e5')).toBe(true);
  expect(ids.has('imdb:tt0903747:s2e5')).toBe(true);
});

it('getWatchedIds surfaces the HTTP status on failure', async () => {
  mockFetch(401, {});
  await expect(getWatchedIds('at', 'movies')).rejects.toMatchObject({ status: 401 });
  mockFetch(500, {});
  await expect(getWatchedIds('at', 'movies')).rejects.toBeInstanceOf(TraktHttpError);
});

it('addToHistory posts a tv play whose imdb id is an EMPTY string, keyed by tmdb', async () => {
  // resolveIds stores '' for a guid of literally `imdb://`. With `??` the empty string became
  // the grouping key, the play was dropped from the POST — while playKey still emitted
  // `tmdb:<id>:sNeM`, so selectUnsynced re-picked it on every single tick, forever.
  const spy = mockFetch(201, {});
  await addToHistory('at', [
    { tmdbId: 1396, imdbId: '', mediaType: 'tv', season: 2, episode: 5, watchedAt: 2_000_000 }
  ]);
  const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
  expect(body.shows).toEqual([{
    ids: { tmdb: 1396 },
    seasons: [{ number: 2, episodes: [{ number: 5, watched_at: new Date(2_000_000).toISOString() }] }]
  }]);
});

it('addToHistory reports the number of entries Trakt could not resolve', async () => {
  mockFetch(201, {
    added: { movies: 1, episodes: 0 },
    not_found: { movies: [{ ids: { tmdb: 42 } }], shows: [{ ids: { tmdb: 7 } }], seasons: [], episodes: [] }
  });
  const n = await addToHistory('at', [
    { tmdbId: 278, imdbId: null, mediaType: 'movie', season: null, episode: null, watchedAt: 1_000 }
  ]);
  expect(n).toBe(2);
});

it('addToHistory reports 0 when everything resolved', async () => {
  mockFetch(201, { added: { movies: 1 }, not_found: { movies: [], shows: [], seasons: [], episodes: [] } });
  const n = await addToHistory('at', [
    { tmdbId: 278, imdbId: null, mediaType: 'movie', season: null, episode: null, watchedAt: 1_000 }
  ]);
  expect(n).toBe(0);
});

// The dedupe contract: the key a pushed play produces MUST be a key the watched set contains.
// These two live in different files and were previously pinned only by hand-matched string
// literals; if they ever drift, every play is re-pushed on every tick forever.
it('playKey matches the keys getWatchedIds builds — movies', async () => {
  mockFetch(200, [{ movie: { ids: { imdb: 'tt0111161', tmdb: 278 } } }]);
  const set = await getWatchedIds('at', 'movies');
  const play: TraktPlay = {
    tmdbId: 278, imdbId: 'tt0111161', mediaType: 'movie', season: null, episode: null, watchedAt: 1_000
  };
  expect(playKey(play).some((k) => set.has(k))).toBe(true);
});

it('playKey matches the keys getWatchedIds builds — episodes', async () => {
  mockFetch(200, [{
    show: { ids: { imdb: 'tt0903747', tmdb: 1396 } },
    seasons: [{ number: 2, episodes: [{ number: 5 }] }]
  }]);
  const set = await getWatchedIds('at', 'shows');
  const play: TraktPlay = {
    tmdbId: 1396, imdbId: 'tt0903747', mediaType: 'tv', season: 2, episode: 5, watchedAt: 2_000
  };
  expect(playKey(play).some((k) => set.has(k))).toBe(true);

  // ...and a DIFFERENT episode of the same show must not match.
  const other: TraktPlay = { ...play, episode: 6 };
  expect(playKey(other).some((k) => set.has(k))).toBe(false);
});
