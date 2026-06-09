import { describe, it, expect, vi, afterEach } from 'vitest';
import { jellyfin } from './jellyfin';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'jellyfin', name: 'JF',
  baseUrl: 'http://jf:8096', secret: 'KEY', options: {}, enabled: true };

afterEach(() => vi.restoreAllMocks());

function mockFetch(map: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    const body = map[path];
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404,
      json: async () => body } as Response;
  }));
}

describe('jellyfin integration', () => {
  it('testConnection ok when /System/Info returns', async () => {
    mockFetch({ '/System/Info': { Version: '10.11' } });
    expect((await jellyfin.testConnection(conn)).ok).toBe(true);
  });
  it('testConnection fails on 404/auth', async () => {
    mockFetch({});
    expect((await jellyfin.testConnection(conn)).ok).toBe(false);
  });
  it('recentlyAdded maps items', async () => {
    mockFetch({ '/Items': { Items: [{ Name: 'Apex', ProductionYear: 2026, Type: 'Movie', Id: 'a' }] } });
    const r = await jellyfin.widgets.recentlyAdded(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any[])[0]).toMatchObject({ title: 'Apex', year: 2026, kind: 'Movie' });
  });

  it('recentlyAdded builds image path when ImageTags.Primary exists', async () => {
    mockFetch({ '/Items': { Items: [{
      Name: 'Apex', ProductionYear: 2026, Type: 'Movie', Id: 'item1',
      ImageTags: { Primary: 'abc123tag' }
    }] } });
    const r = await jellyfin.widgets.recentlyAdded(conn);
    expect(r.ok).toBe(true);
    const item = (r.data as any[])[0];
    expect(item.image).toBe('/Items/item1/Images/Primary?fillWidth=300&fillHeight=450&quality=90&tag=abc123tag');
  });

  it('recentlyAdded sets image to null when no Primary tag', async () => {
    mockFetch({ '/Items': { Items: [{
      Name: 'NoArt', ProductionYear: 2025, Type: 'Series', Id: 'item2',
      ImageTags: {}
    }] } });
    const r = await jellyfin.widgets.recentlyAdded(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any[])[0].image).toBeNull();
  });

  it('recentlyAdded sets image to null when ImageTags is missing', async () => {
    mockFetch({ '/Items': { Items: [{
      Name: 'OldItem', ProductionYear: 2020, Type: 'Movie', Id: 'item3'
    }] } });
    const r = await jellyfin.widgets.recentlyAdded(conn);
    expect(r.ok).toBe(true);
    expect((r.data as any[])[0].image).toBeNull();
  });
  it('nowPlaying keeps only active sessions', async () => {
    mockFetch({ '/Sessions': [
      { UserName: 'a', NowPlayingItem: { Name: 'Apex' }, PlayState: { PositionTicks: 5, } },
      { UserName: 'idle' }
    ] });
    const r = await jellyfin.widgets.nowPlaying(conn);
    expect((r.data as any[]).length).toBe(1);
    expect((r.data as any[])[0]).toMatchObject({ user: 'a', title: 'Apex' });
  });
});

describe('jellyfin detail', () => {
  it('maps the item and returns Available + a single Play action', async () => {
    mockFetch({ '/Items': { Items: [{
      Name: 'Apex', ProductionYear: 2026, Overview: 'An apex.',
      RunTimeTicks: 600_000_000 * 94, CommunityRating: 7.0,
      Genres: ['Action'], ImageTags: { Primary: 'tag9' }
    }] } });
    const d = await jellyfin.detail!(conn, { id: 'item9' });
    expect(d.title).toBe('Apex');
    expect(d.year).toBe(2026);
    expect(d.runtimeMin).toBe(94);
    expect(d.rating).toBe(7.0);
    expect(d.overview).toBe('An apex.');
    expect(d.genres).toEqual(['Action']);
    expect(d.poster).toBe(
      '/api/image/1?path=' +
      encodeURIComponent('/Items/item9/Images/Primary?fillWidth=400&fillHeight=600&quality=90&tag=tag9')
    );
    expect(d.status).toEqual({ label: 'Available', state: 'ok' });
    expect(d.actions.map((a) => a.id)).toEqual(['playInJellyfin']);
  });

  it('detail never leaks the API key', async () => {
    mockFetch({ '/Items': { Items: [{ Name: 'Safe', ImageTags: { Primary: 't' } }] } });
    const d = await jellyfin.detail!(conn, { id: 'x' });
    expect(JSON.stringify(d)).not.toContain('KEY');
  });
});

describe('jellyfin actions', () => {
  it('playInJellyfin returns a secret-free web deep link', async () => {
    const r = await jellyfin.actions!.playInJellyfin.run(conn, { id: 'abc' });
    expect(r).toMatchObject({ ok: true });
    expect(r.url).toBe('http://jf:8096/web/#/details?id=abc');
    expect(r.url).not.toContain('KEY');
  });
});
