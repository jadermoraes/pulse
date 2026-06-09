import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import * as widgets from '../../widgets';
import * as http from '../http';
import { getDiscover, searchDiscover, getDetail, isReleased } from './discover';

let db: DB; let jfId: number; let seerrId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  jfId = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K', options: {} });
  seerrId = createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
});
afterEach(() => vi.restoreAllMocks());

function mockWidgets(map: Record<string, any[]>) {
  vi.spyOn(widgets, 'resolveWidget').mockImplementation(async (_db, _id, w) =>
    map[w] ? { ok: true, data: map[w] } : { ok: true, data: [] });
}

/**
 * URL-aware seerr mock: getDiscover now hits /discover/movies and /discover/tv
 * on separate calls. Route the right payload by URL path.
 */
function mockSeerr(by: { movies?: any[]; tv?: any[] }) {
  vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
    if (url.includes('/discover/movies')) return { results: by.movies ?? [] } as any;
    if (url.includes('/discover/tv')) return { results: by.tv ?? [] } as any;
    return { results: [] } as any;
  });
}

describe('discover', () => {
  it('blends recently-added (on-server, watchable) + seerr hot movies & tv (off-server, requestable), deduped by tmdbId', async () => {
    mockWidgets({
      recentlyAdded: [{ id: 'jf1', title: 'Dune', year: 2021, kind: 'Movie', image: '/img/dune.jpg' }],
      nowPlaying: []
    });
    mockSeerr({
      movies: [{ id: 100, mediaType: 'movie', title: 'Dune', releaseDate: '2021-10-22', posterPath: '/p.jpg' }],
      tv: [{ id: 200, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-18', posterPath: '/s.jpg' }]
    });
    const r = await getDiscover(db);
    const onServer = r.newOnServer.find((i) => i.title === 'Dune')!;
    expect(onServer.onServer).toBe(true);
    expect(onServer.watchUrl).toContain('/web/#/details?id=jf1');
    expect(onServer.poster).toContain(`/api/image/${jfId}`);
    // seerr 'Dune' is a dup of the on-server one → excluded from hot
    expect(r.hot.some((i) => i.title === 'Dune')).toBe(false);
    const sev = r.hot.find((i) => i.title === 'Severance')!;
    expect(sev.onServer).toBe(false);
    expect(sev.tmdbId).toBe(200);
    expect(sev.mediaType).toBe('tv');
  });

  it('fills the hot series row from a separate /discover/tv fetch (not just mixed trending)', async () => {
    mockWidgets({ recentlyAdded: [], nowPlaying: [] });
    const tv = Array.from({ length: 12 }, (_, i) => ({
      id: 500 + i, mediaType: 'tv', name: `Series ${i}`, firstAirDate: '2020-01-01', posterPath: `/t${i}.jpg`
    }));
    const movies = Array.from({ length: 12 }, (_, i) => ({
      id: 600 + i, mediaType: 'movie', title: `Movie ${i}`, releaseDate: '2020-01-01', posterPath: `/m${i}.jpg`
    }));
    mockSeerr({ movies, tv });
    const r = await getDiscover(db);
    const hotTv = r.hot.filter((i) => i.mediaType === 'tv');
    const hotMovies = r.hot.filter((i) => i.mediaType === 'movie');
    expect(hotTv.length).toBeGreaterThanOrEqual(12);
    expect(hotMovies.length).toBeGreaterThanOrEqual(12);
  });

  it('hits the dedicated discover/movies and discover/tv seerr endpoints', async () => {
    mockWidgets({ recentlyAdded: [], nowPlaying: [] });
    const urls: string[] = [];
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      urls.push(url); return { results: [] } as any;
    });
    await getDiscover(db);
    expect(urls.some((u) => u.includes('/api/v1/discover/movies'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/v1/discover/tv'))).toBe(true);
  });

  it('filters unreleased / in-cinemas titles out of the hot rows', async () => {
    mockWidgets({ recentlyAdded: [], nowPlaying: [] });
    mockSeerr({
      movies: [
        { id: 1, mediaType: 'movie', title: 'Out Now', releaseDate: '2020-01-01', posterPath: '/a.jpg' },
        { id: 2, mediaType: 'movie', title: 'In Cinemas 2099', releaseDate: '2099-12-31', posterPath: '/b.jpg' },
        { id: 3, mediaType: 'movie', title: 'No Date', posterPath: '/c.jpg' }
      ],
      tv: []
    });
    const r = await getDiscover(db);
    expect(r.hot.map((i) => i.title)).toEqual(['Out Now']);
  });

  it('enriches hot items with rating / overview / released', async () => {
    mockWidgets({ recentlyAdded: [], nowPlaying: [] });
    mockSeerr({
      movies: [{
        id: 9, mediaType: 'movie', title: 'Rated', releaseDate: '2020-01-01',
        posterPath: '/r.jpg', voteAverage: 7.84, overview: 'A film.'
      }],
      tv: []
    });
    const r = await getDiscover(db);
    const it = r.hot.find((i) => i.title === 'Rated')!;
    expect(it.rating).toBe(7.8);
    expect(it.overview).toBe('A film.');
    expect(it.released).toBe(true);
  });

  it('continueWatching comes from nowPlaying and is on-server', async () => {
    mockWidgets({
      recentlyAdded: [],
      nowPlaying: [{ id: 'jf9', title: 'Andor', kind: 'Series' }]
    });
    mockSeerr({});
    const r = await getDiscover(db);
    expect(r.continueWatching[0].onServer).toBe(true);
    expect(r.continueWatching[0].title).toBe('Andor');
  });

  it('search returns on-server hits first, then seerr catalog', async () => {
    mockWidgets({ recentlyAdded: [{ id: 'jf1', title: 'Dune Part Two', year: 2024, kind: 'Movie', image: '/d.jpg' }] });
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      results: [{ id: 300, mediaType: 'movie', title: 'Dune Messiah', posterPath: '/m.jpg' }]
    } as any);
    const r = await searchDiscover(db, 'dune');
    expect(r[0].onServer).toBe(true);
    expect(r[0].title).toBe('Dune Part Two');
    expect(r.some((i) => i.title === 'Dune Messiah' && !i.onServer)).toBe(true);
  });

  it('search availability comes from seerr mediaInfo.status (5 → available, 3 → requested, none → requestable)', async () => {
    // No Jellyfin matches: availability must be decided purely by seerr status.
    mockWidgets({ recentlyAdded: [], nowPlaying: [] });
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      results: [
        { id: 1, mediaType: 'movie', title: 'Avail', posterPath: '/a.jpg', mediaInfo: { status: 5 } },
        { id: 2, mediaType: 'movie', title: 'Processing', posterPath: '/b.jpg', mediaInfo: { status: 3 } },
        { id: 3, mediaType: 'movie', title: 'Fresh', posterPath: '/c.jpg' }
      ]
    } as any);
    const r = await searchDiscover(db, 'thing');
    const avail = r.find((i) => i.title === 'Avail')!;
    const proc = r.find((i) => i.title === 'Processing')!;
    const fresh = r.find((i) => i.title === 'Fresh')!;
    expect(avail.onServer).toBe(true);
    expect(avail.requested).toBeUndefined();
    expect(proc.onServer).toBe(false);
    expect(proc.requested).toBe(true);
    expect(fresh.onServer).toBe(false);
    expect(fresh.requested).toBeUndefined();
    // Available-now items sort ahead of the rest.
    expect(r[0].title).toBe('Avail');
  });

  it('search does NOT mark a requested-but-undownloaded title as available via a Jellyfin placeholder', async () => {
    // Radarr/Sonarr placeholder shows in recentlyAdded, but seerr says status 3 (processing).
    mockWidgets({
      recentlyAdded: [{ id: 'ph1', title: 'Placeholder Movie', year: 2024, kind: 'Movie', image: '/p.jpg' }],
      nowPlaying: []
    });
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      results: [{ id: 9, mediaType: 'movie', title: 'Placeholder Movie', releaseDate: '2024-01-01', mediaInfo: { status: 3 } }]
    } as any);
    const r = await searchDiscover(db, 'placeholder');
    const item = r.find((i) => i.title === 'Placeholder Movie')!;
    // seerr is authoritative: still requested/processing, NOT available now.
    expect(item.onServer).toBe(false);
    expect(item.requested).toBe(true);
    // The Jellyfin placeholder must not have been added as a separate "available" duplicate.
    expect(r.filter((i) => i.title === 'Placeholder Movie' && i.onServer)).toHaveLength(0);
  });

  it('searchDiscover percent-encodes the seerr query (uses %20, not + for a multi-word search)', async () => {
    vi.spyOn(widgets, 'resolveWidget').mockResolvedValue({ ok: true, data: [] });
    let capturedUrl = '';
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { results: [] } as any;
    });
    await searchDiscover(db, 'heavy trip');
    expect(capturedUrl).toContain('query=heavy%20trip');
    expect(capturedUrl).not.toContain('heavy+trip');
  });

  it('degrades gracefully when a source errors', async () => {
    vi.spyOn(widgets, 'resolveWidget').mockResolvedValue({ ok: false, error: 'down' });
    vi.spyOn(http, 'getJsonWithKey').mockRejectedValue(new Error('seerr down'));
    const r = await getDiscover(db);
    expect(r).toEqual({ newOnServer: [], hot: [], continueWatching: [] });
  });
});

describe('isReleased', () => {
  const NOW = Date.parse('2026-06-05T00:00:00Z');
  it('true when date is on or before now', () => {
    expect(isReleased('2020-01-01', NOW)).toBe(true);
    expect(isReleased('2026-06-05', NOW)).toBe(true);
  });
  it('false for a future date', () => {
    expect(isReleased('2099-12-31', NOW)).toBe(false);
  });
  it('false for a missing or unparseable date', () => {
    expect(isReleased(undefined, NOW)).toBe(false);
    expect(isReleased('', NOW)).toBe(false);
    expect(isReleased('not-a-date', NOW)).toBe(false);
  });
});

describe('getDetail', () => {
  it('maps a movie detail: genres/rating/runtime/available(status 5)', async () => {
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      title: 'Dune', releaseDate: '2021-10-22', overview: 'Sand.',
      runtime: 155, voteAverage: 8.0123, posterPath: '/p.jpg', backdropPath: '/bd.jpg',
      genres: [{ id: 1, name: 'Sci-Fi' }, { id: 2, name: 'Adventure' }],
      mediaInfo: { status: 5 }
    } as any);
    const d = (await getDetail(db, 100, 'movie'))!;
    expect(d.title).toBe('Dune');
    expect(d.year).toBe(2021);
    expect(d.genres).toEqual(['Sci-Fi', 'Adventure']);
    expect(d.rating).toBe(8.0);
    expect(d.runtimeMin).toBe(155);
    expect(d.available).toBe(true);
    expect(d.status).toBe('Available');
    expect(d.poster).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
    expect(d.backdrop).toBe('https://image.tmdb.org/t/p/w780/bd.jpg');
  });

  it('maps a tv detail: episodeRunTime[0] for runtime, name for title', async () => {
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      name: 'Severance', firstAirDate: '2022-02-18', overview: 'Work.',
      episodeRunTime: [50], voteAverage: 8.7, posterPath: '/s.jpg',
      genres: [{ name: 'Drama' }], mediaInfo: { status: 5 }
    } as any);
    const d = (await getDetail(db, 200, 'tv'))!;
    expect(d.title).toBe('Severance');
    expect(d.runtimeMin).toBe(50);
    expect(d.year).toBe(2022);
    expect(d.available).toBe(true);
  });

  it('not-on-server title → available:false, status Not on server', async () => {
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      title: 'Future Film', releaseDate: '2099-01-01',
      genres: [], mediaInfo: { status: 1 }
    } as any);
    const d = (await getDetail(db, 300, 'movie'))!;
    expect(d.available).toBe(false);
    expect(d.status).toBe('Not on server');
  });

  it('requested-but-not-available title → status Requested, available:false', async () => {
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      title: 'Pending Film', releaseDate: '2020-01-01',
      genres: [], mediaInfo: { status: 3 }
    } as any);
    const d = (await getDetail(db, 400, 'movie'))!;
    expect(d.available).toBe(false);
    expect(d.status).toBe('Requested');
  });

  it('passes the viewer language to the seerr detail call (language=pt-BR)', async () => {
    let capturedUrl = '';
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { title: 'Duna', releaseDate: '2021-10-22', overview: 'Areia.', genres: [], mediaInfo: { status: 5 } } as any;
    });
    await getDetail(db, 100, 'movie', 'pt-BR');
    expect(capturedUrl).toContain('/api/v1/movie/100');
    expect(capturedUrl).toContain('language=pt-BR');
  });

  it('defaults the seerr detail call to language=en when no language is given', async () => {
    let capturedUrl = '';
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { title: 'Dune', genres: [], mediaInfo: { status: 1 } } as any;
    });
    await getDetail(db, 200, 'tv');
    expect(capturedUrl).toContain('language=en');
  });

  it('returns null when there is no seerr connection', async () => {
    const db2 = openDb(':memory:'); migrate(db2);
    expect(await getDetail(db2, 1, 'movie')).toBeNull();
  });
});
