import { describe, it, expect, vi, afterEach } from 'vitest';
import { jellystat } from './jellystat';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'jellystat', name: 'Jellystat',
  baseUrl: 'http://jellystat:3000', secret: 'JKEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

// Mock fetch: match by path+method+body-type combo.
// Handlers keyed as "METHOD /path" or "POST /path?type=Movie" etc.
function mockFetch(handler: (url: string, init?: RequestInit) => any) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const result = handler(url, init);
    if (result === undefined) {
      return { ok: false, status: 404, json: async () => null } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => result, _headers: init?.headers } as unknown as Response;
  }));
}

describe('jellystat integration', () => {
  it('testConnection ok and sends x-api-token (never in URL)', async () => {
    mockFetch((url) => {
      if (new URL(url).pathname === '/auth/isconfigured') return true;
    });
    const r = await jellystat.testConnection(conn);
    expect(r.ok).toBe(true);
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).not.toContain('JKEY');
    expect((init.headers as any)['x-api-token']).toBe('JKEY');
  });

  it('testConnection fails on non-200', async () => {
    mockFetch(() => undefined);
    expect((await jellystat.testConnection(conn)).ok).toBe(false);
  });

  describe('popular widget', () => {
    it('POSTs to /stats/getMostViewedByType for Movie and Series, merges and sorts by Plays desc', async () => {
      const calls: any[] = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        const path = new URL(url).pathname;
        if (path !== '/stats/getMostViewedByType') {
          return { ok: false, status: 404, json: async () => null } as unknown as Response;
        }
        const body = JSON.parse(init?.body as string ?? '{}');
        if (body.type === 'Movie') {
          return { ok: true, status: 200, json: async () => [
            { Name: 'Spider-Noir', Id: 'id1', Plays: 9, total_playback_duration: 7200 },
            { Name: 'Blade', Id: 'id2', Plays: 3, total_playback_duration: 3600 }
          ] } as unknown as Response;
        }
        if (body.type === 'Series') {
          return { ok: true, status: 200, json: async () => [
            { Name: 'Dark', Id: 'id3', Plays: 15, total_playback_duration: 50400 },
            { Name: 'Apex', Id: 'id4', Plays: 4, total_playback_duration: 14400 }
          ] } as unknown as Response;
        }
        return { ok: false, status: 503, json: async () => null } as unknown as Response;
      }));

      const r = await jellystat.widgets.popular(conn);
      expect(r.ok).toBe(true);
      const items = r.data as any[];
      // sorted by Plays desc: Dark(15), Spider-Noir(9), Apex(4), Blade(3)
      expect(items[0]).toMatchObject({ title: 'Dark', id: 'id3', plays: 15 });
      expect(items[1]).toMatchObject({ title: 'Spider-Noir', id: 'id1', plays: 9 });
      expect(items[2]).toMatchObject({ title: 'Apex', id: 'id4', plays: 4 });
      expect(items[3]).toMatchObject({ title: 'Blade', id: 'id2', plays: 3 });
      // Both types fetched
      const typesRequested = calls
        .filter((c) => new URL(c.url).pathname === '/stats/getMostViewedByType')
        .map((c) => JSON.parse(c.init.body).type);
      expect(typesRequested).toContain('Movie');
      expect(typesRequested).toContain('Series');
    });

    it('returns ok:true with partial results if one type call fails', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (path !== '/stats/getMostViewedByType') {
          return { ok: false, status: 404, json: async () => null } as unknown as Response;
        }
        const body = JSON.parse(init?.body as string ?? '{}');
        if (body.type === 'Movie') {
          return { ok: true, status: 200, json: async () => [
            { Name: 'Heat', Id: 'id5', Plays: 7 }
          ] } as unknown as Response;
        }
        // Series fails
        return { ok: false, status: 503, json: async () => null } as unknown as Response;
      }));
      const r = await jellystat.widgets.popular(conn);
      expect(r.ok).toBe(true);
      expect((r.data as any[])[0]).toMatchObject({ title: 'Heat', plays: 7 });
    });

    it('returns ok:true with empty array when both type calls fail', async () => {
      vi.stubGlobal('fetch', vi.fn(async () =>
        ({ ok: false, status: 503, json: async () => null }) as unknown as Response
      ));
      const r = await jellystat.widgets.popular(conn);
      expect(r.ok).toBe(true);
      expect(r.data).toEqual([]);
    });
  });

  describe('recent widget', () => {
    it('GETs /api/getHistory and parses {results:[...]} envelope', async () => {
      mockFetch((url) => {
        if (new URL(url).pathname === '/api/getHistory') {
          return {
            results: [
              { NowPlayingItemName: 'Episode 1', SeriesName: 'Dark', UserName: 'Ada',
                Client: 'Jellyfin Web', DeviceName: 'PC', PlaybackDuration: 2700,
                ActivityDateInserted: '2026-05-30T20:00:00Z' },
              { NowPlayingItemName: 'Heat', SeriesName: null, UserName: 'Bob',
                Client: 'Infuse', DeviceName: 'AppleTV', PlaybackDuration: 7200,
                ActivityDateInserted: '2026-05-29T18:00:00Z' }
            ]
          };
        }
      });
      const r = await jellystat.widgets.recent(conn);
      expect(r.ok).toBe(true);
      const { items, count } = r.data as any;
      // Series item: "SeriesName · NowPlayingItemName"
      expect(items[0]).toMatchObject({
        title: 'Dark · Episode 1',
        user: 'Ada',
        client: 'Jellyfin Web',
        device: 'PC',
        when: '2026-05-30T20:00:00Z'
      });
      // Movie item: just NowPlayingItemName
      expect(items[1]).toMatchObject({ title: 'Heat', user: 'Bob' });
      expect(count).toBe(2);
    });

    it('returns ok:false on upstream error', async () => {
      mockFetch(() => undefined);
      const r = await jellystat.widgets.recent(conn);
      expect(r.ok).toBe(false);
    });
  });
});
