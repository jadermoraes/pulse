import { describe, it, expect, vi, afterEach } from 'vitest';
import { seerr, computeSeerrStatus } from './seerr';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'seerr', name: 'Seerr',
  baseUrl: 'http://seerr:5055', secret: 'API-KEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

// Mock fetch by pathname; asserts the X-Api-Key header is sent and never leaks.
function mockFetch(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = map[path];
    const headers = (init?.headers ?? {}) as Record<string, string>;
    return {
      ok: body !== undefined,
      status: body !== undefined ? 200 : 404,
      json: async () => body,
      _sentKey: headers['X-Api-Key']
    } as unknown as Response & { _sentKey?: string };
  }));
}

describe('seerr integration', () => {
  it('testConnection ok and sends X-Api-Key', async () => {
    mockFetch({ '/api/v1/status': { version: '1.9.0' } });
    const r = await seerr.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('1.9.0');
    // the key was sent in the header, not the URL
    const callInit = (fetch as any).mock.calls[0][1] as RequestInit;
    expect((callInit.headers as any)['X-Api-Key']).toBe('API-KEY');
    expect((fetch as any).mock.calls[0][0]).not.toContain('API-KEY');
  });

  it('testConnection fails on 404/auth', async () => {
    mockFetch({});
    expect((await seerr.testConnection(conn)).ok).toBe(false);
  });

  it('requests resolves title and poster via media lookup', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 7, status: 2,
        media: { tmdbId: 550, mediaType: 'movie', status: 3, downloadStatus: [] },
        requestedBy: { displayName: 'Ada' }
      }] },
      '/api/v1/movie/550': { title: 'Fight Club', posterPath: '/poster.jpg', releaseDate: '2000-01-01', status: 'Released' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.title).toBe('Fight Club');
    expect(card.poster).toBe('https://image.tmdb.org/t/p/w342/poster.jpg');
    expect(card.requestedBy).toBe('Ada');
    expect(card.id).toBe(7);
    expect(card.tmdbId).toBe(550);
    expect(card.mediaType).toBe('movie');
    // mediaStatus 3 + no active downloads → Searching, not Processing
    expect(card.status).toBe('Searching');
  });

  it('requests resolves tv via /api/v1/tv/{tmdbId} and uses name field', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 9, status: 1,
        media: { tmdbId: 1399, mediaType: 'tv', status: 2 },
        requestedBy: { displayName: 'Bob' }
      }] },
      '/api/v1/tv/1399': { name: 'Game of Thrones', posterPath: '/got.jpg' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.title).toBe('Game of Thrones');
    expect(card.poster).toBe('https://image.tmdb.org/t/p/w342/got.jpg');
    expect(card.mediaType).toBe('tv');
  });

  it('status mapping — media.status 5 → Available / state ok', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 1, status: 2,
        media: { tmdbId: 100, mediaType: 'movie', status: 5 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/100': { title: 'Done', posterPath: null }
    });
    const r = await seerr.widgets.requests(conn);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Available');
    expect(card.state).toBe('ok');
  });

  it('status mapping — media.status 4 → Partial / state ok', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 2, status: 2,
        media: { tmdbId: 101, mediaType: 'movie', status: 4 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/101': { title: 'Partial Movie', posterPath: null }
    });
    const r = await seerr.widgets.requests(conn);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Partial');
    expect(card.state).toBe('ok');
  });

  it('status mapping — request.status 3 (Declined) → Declined / state bad', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 3, status: 3,
        media: { tmdbId: 102, mediaType: 'movie', status: 1 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/102': { title: 'Nope', posterPath: null }
    });
    const r = await seerr.widgets.requests(conn);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Declined');
    expect(card.state).toBe('bad');
  });

  it('status mapping — request.status 4 (Failed) → Failed / state bad', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 4, status: 4,
        media: { tmdbId: 103, mediaType: 'movie', status: 1 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/103': { title: 'Failed Movie', posterPath: null }
    });
    const r = await seerr.widgets.requests(conn);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Failed');
    expect(card.state).toBe('bad');
  });

  it('parallel-lookup fallback — failed media lookup falls back gracefully', async () => {
    // movie/200 returns 404; movie/201 succeeds — both requests should still appear
    mockFetch({
      '/api/v1/request': { results: [
        { id: 10, status: 2, media: { tmdbId: 200, mediaType: 'movie', status: 3, downloadStatus: [] }, requestedBy: { displayName: 'Alice' } },
        { id: 11, status: 2, media: { tmdbId: 201, mediaType: 'movie', status: 3, downloadStatus: [] }, requestedBy: { displayName: 'Bob' } }
      ] },
      // 200 intentionally absent → 404 → fallback
      '/api/v1/movie/201': { title: 'The Matrix', posterPath: '/matrix.jpg', releaseDate: '2000-01-01', status: 'Released' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const cards = r.data as any[];
    expect(cards).toHaveLength(2);
    // failed lookup → fallback title, null poster
    const failed = cards.find((c) => c.id === 10);
    expect(failed.title).toBe('movie #200');
    expect(failed.poster).toBeNull();
    // successful lookup
    const ok = cards.find((c) => c.id === 11);
    expect(ok.title).toBe('The Matrix');
    expect(ok.poster).toContain('image.tmdb.org');
  });

  it('poster is null when posterPath is absent or null', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 5, status: 2,
        media: { tmdbId: 104, mediaType: 'movie', status: 2 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/104': { title: 'No Poster', posterPath: null }
    });
    const r = await seerr.widgets.requests(conn);
    const card = (r.data as any[])[0];
    expect(card.poster).toBeNull();
  });

  it('API key is never leaked into the response payload', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 6, status: 2,
        media: { tmdbId: 105, mediaType: 'movie', status: 5 },
        requestedBy: { displayName: 'X' }
      }] },
      '/api/v1/movie/105': { title: 'Secret Safe', posterPath: '/s.jpg' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(JSON.stringify(r)).not.toContain('API-KEY');
  });

  it('requestCounts returns the count object', async () => {
    mockFetch({ '/api/v1/request/count': { total: 12, pending: 3, approved: 8, declined: 1 } });
    const r = await seerr.widgets.requestCounts(conn);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ total: 12, pending: 3, approved: 8, declined: 1 });
  });

  it('widget returns ok:false on upstream error (per-widget isolation)', async () => {
    mockFetch({});
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

describe('computeSeerrStatus helper', () => {
  const future = '2999-01-01';
  const past = '2000-01-01';

  it('Declined (requestStatus 3) → bad regardless of media/release', () => {
    expect(computeSeerrStatus({ requestStatus: 3, mediaStatus: 1, releaseDate: past, tmdbStatus: 'Released' }))
      .toEqual({ label: 'Declined', state: 'bad' });
  });

  it('Failed (requestStatus 4) → bad', () => {
    expect(computeSeerrStatus({ requestStatus: 4, mediaStatus: 5, releaseDate: past, tmdbStatus: 'Released' }))
      .toEqual({ label: 'Failed', state: 'bad' });
  });

  it('Available (mediaStatus 5) → ok', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 5 }))
      .toEqual({ label: 'Available', state: 'ok' });
  });

  it('Partial (mediaStatus 4) → ok', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 4 }))
      .toEqual({ label: 'Partial', state: 'ok' });
  });

  it('Searching (mediaStatus 3, downloadCount 0, released) → proc (monitored but not downloading)', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 3, releaseDate: past, tmdbStatus: 'Released', downloadCount: 0 }))
      .toEqual({ label: 'Searching', state: 'proc' });
  });

  it('Downloading (mediaStatus 3, downloadCount 1, released) → proc (active download)', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 3, releaseDate: past, tmdbStatus: 'Released', downloadCount: 1 }))
      .toEqual({ label: 'Downloading', state: 'proc' });
  });

  it('Downloading (mediaStatus 2, downloadCount 2) → proc (active download wins over Queued)', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 2, releaseDate: past, tmdbStatus: 'Released', downloadCount: 2 }))
      .toEqual({ label: 'Downloading', state: 'proc' });
  });

  it('Pending (requestStatus 1) → proc', () => {
    expect(computeSeerrStatus({ requestStatus: 1, mediaStatus: 2, releaseDate: past, tmdbStatus: 'Released' }))
      .toEqual({ label: 'Pending', state: 'proc' });
  });

  it('Unreleased — future releaseDate → idle', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 2, releaseDate: future, tmdbStatus: 'Post Production' }))
      .toEqual({ label: 'Unreleased', state: 'idle' });
  });

  it('Unreleased — no date, tmdbStatus not Released → idle', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 2, tmdbStatus: 'Announced' }))
      .toEqual({ label: 'Unreleased', state: 'idle' });
  });

  it('Unreleased — no date, no tmdbStatus → idle', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 2 }))
      .toEqual({ label: 'Unreleased', state: 'idle' });
  });

  it('Queued — approved, released, mediaStatus 2 → proc', () => {
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 2, releaseDate: past, tmdbStatus: 'Released' }))
      .toEqual({ label: 'Queued', state: 'proc' });
  });

  it('Unreleased — future releaseDate, mediaStatus 3, no downloads → Unreleased (released check before Searching)', () => {
    // No active download → skip Downloading; then Unreleased check happens before Searching
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 3, releaseDate: future, downloadCount: 0 }))
      .toEqual({ label: 'Unreleased', state: 'idle' });
  });

  it('Downloading beats Unreleased — active download even for future-release title', () => {
    // If somehow a download is active on an unreleased title, trust the download count
    expect(computeSeerrStatus({ requestStatus: 2, mediaStatus: 3, releaseDate: future, downloadCount: 1 }))
      .toEqual({ label: 'Downloading', state: 'proc' });
  });
});

describe('seerr widget — unreleased title detection', () => {
  it('unreleased title (future releaseDate, mediaStatus 2) → Unreleased / idle', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 20, status: 2,
        media: { tmdbId: 999, mediaType: 'movie', status: 2 },
        requestedBy: { displayName: 'Alice' }
      }] },
      '/api/v1/movie/999': { title: 'Not Out Yet', posterPath: null, releaseDate: '2999-06-01', status: 'Post Production' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Unreleased');
    expect(card.state).toBe('idle');
  });

  it('unreleased tv (future firstAirDate, mediaStatus 2) → Unreleased / idle', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 21, status: 2,
        media: { tmdbId: 888, mediaType: 'tv', status: 2 },
        requestedBy: { displayName: 'Bob' }
      }] },
      '/api/v1/tv/888': { name: 'Future Show', posterPath: null, firstAirDate: '2999-09-15', status: 'Planned' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Unreleased');
    expect(card.state).toBe('idle');
  });

  it('released movie (past releaseDate, mediaStatus 2, approved) → Queued', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 22, status: 2,
        media: { tmdbId: 777, mediaType: 'movie', status: 2 },
        requestedBy: { displayName: 'Carol' }
      }] },
      '/api/v1/movie/777': { title: 'Already Out', posterPath: null, releaseDate: '2000-01-01', status: 'Released' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Queued');
    expect(card.state).toBe('proc');
  });

  it('mediaStatus 3 + no active downloads + future release → Unreleased (not Downloading/Processing)', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 23, status: 2,
        media: { tmdbId: 666, mediaType: 'movie', status: 3, downloadStatus: [] },
        requestedBy: { displayName: 'Dave' }
      }] },
      '/api/v1/movie/666': { title: 'Being Processed', posterPath: null, releaseDate: '2999-12-01', status: 'Post Production' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Unreleased');
    expect(card.state).toBe('idle');
  });

  it('mediaStatus 3 + active downloads → Downloading (the only real "processing")', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 24, status: 2,
        media: { tmdbId: 667, mediaType: 'movie', status: 3, downloadStatus: [{ id: 1 }] },
        requestedBy: { displayName: 'Eve' }
      }] },
      '/api/v1/movie/667': { title: 'Actively Downloading', posterPath: null, releaseDate: '2000-01-01', status: 'Released' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Downloading');
    expect(card.state).toBe('proc');
  });

  it('mediaStatus 3 + released + no active downloads → Searching (monitored but not downloading)', async () => {
    mockFetch({
      '/api/v1/request': { results: [{
        id: 25, status: 2,
        media: { tmdbId: 668, mediaType: 'movie', status: 3, downloadStatus: [] },
        requestedBy: { displayName: 'Frank' }
      }] },
      '/api/v1/movie/668': { title: 'In Cinemas', posterPath: null, releaseDate: '2000-01-01', status: 'Released' }
    });
    const r = await seerr.widgets.requests(conn);
    expect(r.ok).toBe(true);
    const card = (r.data as any[])[0];
    expect(card.status).toBe('Searching');
    expect(card.state).toBe('proc');
  });
});

describe('seerr actions', () => {
  it('approve POSTs to /request/{id}/approve with header auth and no key in URL', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 200, json: async () => ({ id: 7, status: 2 }) } as Response;
    }));
    const r = await seerr.actions!.approve.run(conn, { id: 7 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toBe('http://seerr:5055/api/v1/request/7/approve');
    expect(calls[0][0]).not.toContain('API-KEY');
    expect((calls[0][1].headers as any)['X-Api-Key']).toBe('API-KEY');
    expect(calls[0][1].method).toBe('POST');
  });
  it('decline POSTs to /request/{id}/decline', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]); return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    const r = await seerr.actions!.decline.run(conn, { id: 7 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toBe('http://seerr:5055/api/v1/request/7/decline');
  });
  it('research surfaces an upstream failure as ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) } as Response)));
    const r = await seerr.actions!.research.run(conn, { id: 7 });
    expect(r.ok).toBe(false);
  });

  it('request POSTs to /api/v1/request with movie mediaType and no userId (owner attribution)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 201, json: async () => ({ id: 99, status: 1 }) } as Response;
    }));
    const r = await seerr.actions!.request.run(conn, { mediaType: 'movie', tmdbId: 550 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toBe('http://seerr:5055/api/v1/request');
    expect(calls[0][1].method).toBe('POST');
    expect((calls[0][1].headers as any)['X-Api-Key']).toBe('API-KEY');
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ mediaType: 'movie', mediaId: 550 });
    expect(body.userId).toBeUndefined();
  });

  it('request includes a numeric userId when provided (consumer attribution)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 201, json: async () => ({ id: 99 }) } as Response;
    }));
    await seerr.actions!.request.run(conn, { mediaType: 'movie', tmdbId: '550', userId: 4 });
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ mediaType: 'movie', mediaId: 550, userId: 4 });
  });

  it('request for tv includes seasons:"all"', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return { ok: true, status: 201, json: async () => ({ id: 99 }) } as Response;
    }));
    await seerr.actions!.request.run(conn, { mediaType: 'tv', tmdbId: 1399 });
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ mediaType: 'tv', mediaId: 1399, seasons: 'all' });
  });

  it('viewInSeerr returns the media-page deep link with no secret', async () => {
    const r = await seerr.actions!.viewInSeerr.run(conn, { tmdbId: 550, mediaType: 'movie' });
    expect(r.ok).toBe(true);
    expect(r.url).toBe('http://seerr:5055/movie/550');
    expect(JSON.stringify(r)).not.toContain('API-KEY');
  });

  it('percent-encodes path params containing "/" or ".."', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    await seerr.actions!.approve.run(conn, { id: '../evil' });
    expect(calls[0]).not.toContain('../evil');
    expect(calls[0]).toContain(encodeURIComponent('../evil'));

    calls.length = 0;
    await seerr.actions!.decline.run(conn, { id: 'foo/bar' });
    expect(calls[0]).not.toContain('foo/bar');
    expect(calls[0]).toContain(encodeURIComponent('foo/bar'));

    calls.length = 0;
    await seerr.actions!.research.run(conn, { id: '7/../../other' });
    expect(calls[0]).not.toContain('7/../../other');
    expect(calls[0]).toContain(encodeURIComponent('7/../../other'));
  });
});

describe('seerr detail', () => {
  const future = '2999-01-01';
  const past = '2000-01-01';

  it('Available (mediaInfo 5) → NO approve/decline, has research + viewInSeerr', async () => {
    mockFetch({
      '/api/v1/request/7': { status: 2, media: { status: 5 } },
      '/api/v1/movie/550': {
        title: 'Fight Club', releaseDate: past, runtime: 139, voteAverage: 8.4,
        status: 'Released', imdbId: 'tt0137523', overview: 'A man.', posterPath: '/p.jpg',
        genres: [{ name: 'Drama' }, { name: 'Thriller' }]
      }
    });
    const d = await seerr.detail!(conn, { id: 7, tmdbId: 550, mediaType: 'movie' });
    expect(d.status).toEqual({ label: 'Available', state: 'ok' });
    expect(d.title).toBe('Fight Club');
    expect(d.poster).toBe('https://image.tmdb.org/t/p/w342/p.jpg');
    expect(d.runtimeMin).toBe(139);
    expect(d.rating).toBe(8.4);
    expect(d.imdbUrl).toBe('https://www.imdb.com/title/tt0137523');
    expect(d.genres).toEqual(['Drama', 'Thriller']);
    const ids = d.actions.map((a) => a.id);
    expect(ids).toContain('research');
    expect(ids).toContain('viewInSeerr');
    expect(ids).not.toContain('approve');
    expect(ids).not.toContain('decline');
  });

  it('Pending (request 1) → approve + decline present', async () => {
    mockFetch({
      '/api/v1/request/9': { status: 1, media: { status: 2 } },
      '/api/v1/movie/600': { title: 'Pending Film', releaseDate: past, status: 'Released' }
    });
    const d = await seerr.detail!(conn, { id: 9, tmdbId: 600, mediaType: 'movie' });
    expect(d.status).toEqual({ label: 'Pending', state: 'proc' });
    const ids = d.actions.map((a) => a.id);
    expect(ids).toContain('approve');
    expect(ids).toContain('decline');
    expect(ids).toContain('research');
  });

  it('Unreleased (future release) → idle + only viewInSeerr, releaseDate present', async () => {
    mockFetch({
      '/api/v1/request/3': { status: 2, media: { status: 2 } },
      '/api/v1/movie/700': { title: 'Future', releaseDate: future, status: 'Post Production' }
    });
    const d = await seerr.detail!(conn, { id: 3, tmdbId: 700, mediaType: 'movie' });
    expect(d.status).toEqual({ label: 'Unreleased', state: 'idle' });
    expect(d.releaseDate).toBe(future);
    expect(d.actions.map((a) => a.id)).toEqual(['viewInSeerr']);
  });

  it('Queued (approved, released, mediaInfo 2) → proc with decline', async () => {
    mockFetch({
      '/api/v1/request/4': { status: 2, media: { status: 2 } },
      '/api/v1/movie/800': { title: 'Queued', releaseDate: past, status: 'Released' }
    });
    const d = await seerr.detail!(conn, { id: 4, tmdbId: 800, mediaType: 'movie' });
    expect(d.status).toEqual({ label: 'Queued', state: 'proc' });
    expect(d.actions.map((a) => a.id)).toContain('decline');
  });

  it('TV uses name + firstAirDate + episodeRunTime', async () => {
    mockFetch({
      '/api/v1/request/5': { status: 2, media: { status: 5 } },
      '/api/v1/tv/1399': { name: 'GoT', firstAirDate: '2011-04-17', episodeRunTime: [57], status: 'Released' }
    });
    const d = await seerr.detail!(conn, { id: 5, tmdbId: 1399, mediaType: 'tv' });
    expect(d.title).toBe('GoT');
    expect(d.year).toBe(2011);
    expect(d.runtimeMin).toBe(57);
  });

  it('detail never leaks the API key', async () => {
    mockFetch({
      '/api/v1/request/6': { status: 2, media: { status: 5 } },
      '/api/v1/movie/900': { title: 'Safe', releaseDate: past, status: 'Released' }
    });
    const d = await seerr.detail!(conn, { id: 6, tmdbId: 900, mediaType: 'movie' });
    expect(JSON.stringify(d)).not.toContain('API-KEY');
  });
});
