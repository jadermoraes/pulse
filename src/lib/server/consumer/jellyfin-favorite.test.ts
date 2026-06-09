import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveJellyfinItemId, setFavorite } from './jellyfin-favorite';

const conn = { id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'KEY', options: {}, enabled: true } as any;
afterEach(() => vi.unstubAllGlobals());

it('resolveJellyfinItemId queries /Items by tmdb provider id and returns the first item id', async () => {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ Items: [{ Id: 'jf-42' }] }), { status: 200 });
  }));
  const id = await resolveJellyfinItemId(conn, 100);
  expect(id).toBe('jf-42');
  expect(calls[0]).toContain('/Items');
  expect(calls[0]).toContain('AnyProviderIdEquals=tmdb.100');
  expect(calls[0]).toContain('api_key=KEY');
});

it('resolveJellyfinItemId returns null when there is no match', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ Items: [] }), { status: 200 })));
  expect(await resolveJellyfinItemId(conn, 100)).toBeNull();
});

it('setFavorite POSTs to favorite and DELETEs to unfavorite, returns true on 200', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response('{}', { status: 200 });
  }));
  expect(await setFavorite(conn, 'user-1', 'jf-42', true)).toBe(true);
  expect(calls[0].method).toBe('POST');
  expect(calls[0].url).toContain('/Users/user-1/FavoriteItems/jf-42');
  expect(await setFavorite(conn, 'user-1', 'jf-42', false)).toBe(true);
  expect(calls[1].method).toBe('DELETE');
});

it('setFavorite returns false (no throw) on a non-2xx', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
  expect(await setFavorite(conn, 'user-1', 'jf-42', true)).toBe(false);
});
