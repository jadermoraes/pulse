import { describe, it, expect, vi, afterEach } from 'vitest';
import { sonarr } from './sonarr';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'sonarr', name: 'Sonarr',
  baseUrl: 'http://sonarr:8989', secret: 'SKEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

function mockFetch(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = map[path];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404,
      json: async () => body } as Response;
  }));
}

describe('sonarr integration', () => {
  it('testConnection ok on /api/v3/system/status', async () => {
    mockFetch({ '/api/v3/system/status': { version: '4.0.1' } });
    const r = await sonarr.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('4.0.1');
  });

  it('queue maps series title + progress + status', async () => {
    mockFetch({ '/api/v3/queue': { records: [{
      id: 2, title: 'Show.S01E01.1080p', status: 'downloading',
      size: 800, sizeleft: 200,
      series: { title: 'Show' }, episode: { seasonNumber: 1, episodeNumber: 1 }
    }] } });
    const r = await sonarr.widgets.queue(conn);
    expect(r.ok).toBe(true);
    const row = (r.data as any[])[0];
    expect(row).toMatchObject({ id: 2, title: 'Show · S1·E1', status: 'downloading' });
    expect(row.progress).toBe(75); // (800-200)/800
  });

  it('wanted returns count + mapped episode items with poster and releaseDate', async () => {
    mockFetch({ '/api/v3/wanted/missing': {
      totalRecords: 2,
      records: [
        {
          title: 'The Heist',
          seasonNumber: 3, episodeNumber: 5,
          airDateUtc: '2026-04-12T02:00:00Z',
          series: {
            title: 'Breaking Bad Reboot', year: 2025,
            images: [{ coverType: 'poster', remoteUrl: 'https://image.tmdb.org/bbr.jpg' }]
          }
        },
        {
          title: null,
          seasonNumber: 1, episodeNumber: 1,
          airDateUtc: null,
          series: { title: 'New Show', year: 2026, images: [] }
        }
      ]
    } });
    const r = await sonarr.widgets.wanted(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).count).toBe(2);
    const items = (r.data as any).items as any[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Breaking Bad Reboot — S03·E05 — The Heist',
      year: 2025, status: 'wanted',
      poster: 'https://image.tmdb.org/bbr.jpg',
      releaseDate: '2026-04-12T02:00:00Z'
    });
    expect(items[1]).toMatchObject({
      title: 'New Show — S01·E01',
      poster: null, releaseDate: null
    });
  });

  it('wanted returns count:0 and empty items on empty records', async () => {
    mockFetch({ '/api/v3/wanted/missing': { totalRecords: 0, records: [] } });
    const r = await sonarr.widgets.wanted(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any).count).toBe(0);
    expect((r.data as any).items).toHaveLength(0);
  });

  it('queue returns ok:false on upstream error', async () => {
    mockFetch({});
    expect((await sonarr.widgets.queue(conn)).ok).toBe(false);
  });
});

describe('sonarr actions', () => {
  it('deleteQueue DELETEs /queue/{id} with blocklist', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]); return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));
    const r = await sonarr.actions!.deleteQueue.run(conn, { id: 9 });
    expect(r.ok).toBe(true);
    expect(calls[0][0]).toContain('/api/v3/queue/9');
    expect(calls[0][0]).toContain('blocklist=true');
    expect(calls[0][1].method).toBe('DELETE');
  });
  it('research POSTs a SeriesSearch command', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]); return { ok: true, status: 201, json: async () => ({}) } as Response;
    }));
    const r = await sonarr.actions!.research.run(conn, { seriesId: 3 });
    expect(r.ok).toBe(true);
    expect(JSON.parse(calls[0][1].body)).toMatchObject({ name: 'SeriesSearch', seriesId: 3 });
  });
  it('manageLink returns a deep link with no secret', async () => {
    const r = await sonarr.actions!.manageLink.run(conn, { titleSlug: 'show' });
    expect(r.url).toBe('http://sonarr:8989/series/show');
    expect(r.url).not.toContain('SKEY');
  });

  it('percent-encodes path params containing "/" or ".." in deleteQueue and manageLink', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }));

    await sonarr.actions!.deleteQueue.run(conn, { id: '../evil' });
    expect(calls[0]).not.toContain('../evil');
    expect(calls[0]).toContain(encodeURIComponent('../evil'));

    const r = await sonarr.actions!.manageLink.run(conn, { titleSlug: '../escape' });
    expect(r.url).not.toContain('../escape');
    expect(r.url).toContain(encodeURIComponent('../escape'));
  });
});

describe('sonarr detail', () => {
  it('Available (all episodes filed) → research + manage', async () => {
    mockFetch({ '/api/v3/series/42': {
      id: 42, title: 'Breaking Bad', year: 2008, runtime: 47, overview: 'Chem.',
      status: 'ended', firstAired: '2008-01-20', imdbId: 'tt0903747',
      ratings: { value: 9.5 }, titleSlug: 'breaking-bad',
      images: [{ coverType: 'poster', remoteUrl: 'http://img/bb.jpg' }], genres: ['Drama'],
      statistics: { episodeFileCount: 62, episodeCount: 62 }
    } });
    const d = await sonarr.detail!(conn, { seriesId: 42 });
    expect(d.status).toEqual({ label: 'Available', state: 'ok' });
    expect(d.title).toBe('Breaking Bad');
    expect(d.poster).toBe('http://img/bb.jpg');
    expect(d.rating).toBe(9.5);
    expect(d.imdbUrl).toBe('https://www.imdb.com/title/tt0903747');
    expect(d.actions.map((a) => a.id)).toEqual(['research', 'manageLink']);
  });

  it('Partial (some episodes filed) → ok state', async () => {
    mockFetch({ '/api/v3/series/43': {
      id: 43, title: 'P', status: 'continuing', firstAired: '2010-01-01',
      statistics: { episodeFileCount: 3, episodeCount: 10 }
    } });
    const d = await sonarr.detail!(conn, { seriesId: 43 });
    expect(d.status).toEqual({ label: 'Partial', state: 'ok' });
  });

  it('Unreleased (announced, future) → manage only', async () => {
    mockFetch({ '/api/v3/series/44': {
      id: 44, title: 'Soon', status: 'announced', firstAired: '2999-01-01',
      statistics: { episodeFileCount: 0, episodeCount: 0 }
    } });
    const d = await sonarr.detail!(conn, { seriesId: 44 });
    expect(d.status).toEqual({ label: 'Unreleased', state: 'idle' });
    expect(d.actions.map((a) => a.id)).toEqual(['manageLink']);
  });

  it('Missing (released, no files) + fromQueue → includes delete', async () => {
    mockFetch({ '/api/v3/series/45': {
      id: 45, title: 'Gone', status: 'continuing', firstAired: '2000-01-01',
      statistics: { episodeFileCount: 0, episodeCount: 8 }
    } });
    const d = await sonarr.detail!(conn, { seriesId: 45, fromQueue: 'true', id: 5 });
    expect(d.status).toEqual({ label: 'Missing', state: 'proc' });
    expect(d.actions.map((a) => a.id)).toContain('deleteQueue');
  });

  it('detail never leaks the API key', async () => {
    mockFetch({ '/api/v3/series/46': {
      id: 46, title: 'Safe', status: 'ended', firstAired: '2000-01-01',
      statistics: { episodeFileCount: 1, episodeCount: 1 }
    } });
    const d = await sonarr.detail!(conn, { seriesId: 46 });
    expect(JSON.stringify(d)).not.toContain('SKEY');
  });
});
