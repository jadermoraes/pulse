import { describe, it, expect, vi, afterEach } from 'vitest';
import { radarr } from './radarr';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'radarr', name: 'Radarr',
  baseUrl: 'http://radarr:7878', secret: 'RKEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

function mockFetch(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = map[path];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404,
      json: async () => body } as Response;
  }));
}

describe('radarr integration', () => {
  it('testConnection ok on /api/v3/system/status', async () => {
    mockFetch({ '/api/v3/system/status': { version: '5.2.6' } });
    const r = await radarr.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('5.2.6');
  });

  it('testConnection fails on 404', async () => {
    mockFetch({});
    expect((await radarr.testConnection(conn)).ok).toBe(false);
  });

  it('queue maps title + progress + status', async () => {
    mockFetch({ '/api/v3/queue': { records: [{
      id: 1, title: 'Apex.2026.1080p', status: 'downloading',
      size: 1000, sizeleft: 250, movie: { title: 'Apex', year: 2026 }
    }] } });
    const r = await radarr.widgets.queue(conn);
    expect(r.ok).toBe(true);
    const row = (r.data as any[])[0];
    expect(row).toMatchObject({ id: 1, title: 'Apex', status: 'downloading' });
    expect(row.progress).toBe(75); // (1000-250)/1000
  });

  it('wanted returns count + mapped items with poster and releaseDate', async () => {
    mockFetch({ '/api/v3/wanted/missing': {
      totalRecords: 2,
      records: [
        {
          title: 'Dune: Part Three', year: 2026, status: 'announced',
          inCinemas: '2026-11-20', digitalRelease: null, physicalRelease: null, releaseDate: null,
          images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/dune3.jpg' }],
          imdbId: 'tt1234567', runtime: 155
        },
        {
          title: 'Blade', year: 2025, status: 'inCinemas',
          inCinemas: null, digitalRelease: '2025-08-01', physicalRelease: null, releaseDate: null,
          images: [],
          imdbId: null, runtime: 120
        }
      ]
    } });
    const r = await radarr.widgets.wanted(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).count).toBe(2);
    const items = (r.data as any).items as any[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Dune: Part Three', year: 2026, status: 'announced',
      poster: 'https://image.tmdb.org/dune3.jpg',
      imdbId: 'tt1234567', runtime: 155, releaseDate: '2026-11-20'
    });
    expect(items[1]).toMatchObject({
      title: 'Blade', year: 2025, poster: null, releaseDate: '2025-08-01'
    });
  });

  it('wanted returns count:0 and empty items on empty records', async () => {
    mockFetch({ '/api/v3/wanted/missing': { totalRecords: 0, records: [] } });
    const r = await radarr.widgets.wanted(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).count).toBe(0);
    expect((r.data as any).items).toHaveLength(0);
  });

  it('queue returns ok:false on upstream error', async () => {
    mockFetch({});
    const r = await radarr.widgets.queue(conn);
    expect(r.ok).toBe(false);
  });
});

describe('radarr actions', () => {
  it('deleteQueue DELETEs /queue/{id} with blocklist + removeFromClient', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]); return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    const r = await radarr.actions!.deleteQueue.run(conn, { id: 5 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toContain('/api/v3/queue/5');
    expect(calls[0][0]).toContain('blocklist=true');
    expect(calls[0][1].method).toBe('DELETE');
    expect(calls[0][0]).not.toContain('RKEY');
  });
  it('research POSTs a MoviesSearch command', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]); return { ok: true, status: 201, json: async () => ({ id: 1 }) } as Response;
    }));
    const r = await radarr.actions!.research.run(conn, { movieId: 12 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toContain('/api/v3/command');
    expect(JSON.parse(calls[0][1].body)).toMatchObject({ name: 'MoviesSearch', movieIds: [12] });
  });
  it('manageLink returns a deep link with no secret', async () => {
    const r = await radarr.actions!.manageLink.run(conn, { movieId: 12 });
    expect(r).toMatchObject({ ok: true });
    expect(r.url).toBe('http://radarr:7878/movie/12');
    expect(r.url).not.toContain('RKEY');
  });

  it('percent-encodes path params containing "/" or ".." in deleteQueue and manageLink', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));

    await radarr.actions!.deleteQueue.run(conn, { id: '../evil' });
    expect(calls[0]).not.toContain('../evil');
    expect(calls[0]).toContain(encodeURIComponent('../evil'));

    const r = await radarr.actions!.manageLink.run(conn, { movieId: '../escape' });
    expect(r.url).not.toContain('../escape');
    expect(r.url).toContain(encodeURIComponent('../escape'));
  });
});

describe('radarr detail', () => {
  it('Available (hasFile) → research + manage, NO delete unless fromQueue', async () => {
    mockFetch({ '/api/v3/movie': [{
      id: 12, title: 'Dune', year: 2021, runtime: 155, overview: 'Sand.',
      status: 'released', digitalRelease: '2021-10-22', hasFile: true,
      imdbId: 'tt1160419', ratings: { tmdb: { value: 8.0 }, imdb: { value: 8.1 } },
      images: [{ coverType: 'poster', remoteUrl: 'http://img/dune.jpg' }], genres: ['Sci-Fi']
    }] });
    const d = await radarr.detail!(conn, { tmdbId: 438631 });
    expect(d.status).toEqual({ label: 'Available', state: 'ok' });
    expect(d.title).toBe('Dune');
    expect(d.poster).toBe('http://img/dune.jpg');
    expect(d.rating).toBe(8.0);
    expect(d.imdbUrl).toBe('https://www.imdb.com/title/tt1160419');
    const ids = d.actions.map((a) => a.id);
    expect(ids).toEqual(['research', 'manageLink']);
  });

  it('Available from queue → includes delete', async () => {
    mockFetch({ '/api/v3/movie': [{ id: 1, title: 'X', hasFile: true, status: 'released', digitalRelease: '2000-01-01' }] });
    const d = await radarr.detail!(conn, { tmdbId: 1, fromQueue: 'true', id: 99 });
    expect(d.actions.map((a) => a.id)).toContain('deleteQueue');
  });

  it('Unreleased (future, announced) → manage only + releaseDate', async () => {
    mockFetch({ '/api/v3/movie': [{ id: 2, title: 'Soon', status: 'announced', digitalRelease: '2999-01-01', hasFile: false }] });
    const d = await radarr.detail!(conn, { tmdbId: 2 });
    expect(d.status).toEqual({ label: 'Unreleased', state: 'idle' });
    expect(d.releaseDate).toBe('2999-01-01');
    expect(d.actions.map((a) => a.id)).toEqual(['manageLink']);
  });

  it('Missing (released, no file) → research + manage', async () => {
    mockFetch({ '/api/v3/movie': [{ id: 3, title: 'Gone', status: 'released', digitalRelease: '2000-01-01', hasFile: false }] });
    const d = await radarr.detail!(conn, { tmdbId: 3 });
    expect(d.status).toEqual({ label: 'Missing', state: 'proc' });
    expect(d.actions.map((a) => a.id)).toEqual(['research', 'manageLink']);
  });

  it('detail never leaks the API key', async () => {
    mockFetch({ '/api/v3/movie': [{ id: 4, title: 'Safe', hasFile: true, status: 'released', digitalRelease: '2000-01-01' }] });
    const d = await radarr.detail!(conn, { tmdbId: 4 });
    expect(JSON.stringify(d)).not.toContain('RKEY');
  });
});
