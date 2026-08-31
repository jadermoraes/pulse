import { it, expect, afterEach, vi } from 'vitest';
import {
  listLibrary, findByImdb, findEpisode, upstreamStreamUrl, _resetLibraryIndex, type LibraryItem
} from './jellyfin-library';
import type { Connection } from '../connections';

const conn = {
  id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096/', secret: 'KEY',
  options: {}, enabled: true
} as Connection;

const realFetch = global.fetch;
// The library index is process-global and keyed on the connection, which every test here shares.
// Without this, one test's stubbed library answers the next test's lookup.
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); _resetLibraryIndex(); });

function stub(payload: unknown): string[] {
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    urls.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as any);
  return urls;
}

const ITEM = {
  Id: 'jf-1', Name: 'Shawshank', ProductionYear: 1994,
  ProviderIds: { Imdb: 'tt0111161', Tmdb: '278' },
  ImageTags: { Primary: 'tag1' }, Type: 'Movie'
};

it('lists movies with paging, and never leaks the api key into the returned items', async () => {
  const urls = stub({ Items: [ITEM] });
  const out = await listLibrary(conn, { type: 'movie', skip: 40, limit: 20 });
  expect(urls[0]).toContain('/Items');
  expect(urls[0]).toContain('IncludeItemTypes=Movie');
  expect(urls[0]).toContain('Recursive=true');
  expect(urls[0]).toContain('StartIndex=40');
  expect(urls[0]).toContain('Limit=20');
  expect(urls[0]).toContain('Fields=ProviderIds%2CProductionYear');
  expect(out).toEqual([{
    jellyfinId: 'jf-1', imdbId: 'tt0111161', type: 'movie',
    name: 'Shawshank', year: 1994, posterTag: 'tag1'
  }]);
  expect(JSON.stringify(out)).not.toContain('KEY');
});

it('maps the series type to Jellyfin Series, not Movie', async () => {
  const urls = stub({ Items: [] });
  await listLibrary(conn, { type: 'series', skip: 0, limit: 10 });
  expect(urls[0]).toContain('IncludeItemTypes=Series');
  expect(urls[0]).not.toContain('IncludeItemTypes=Movie');
});

it('passes a search term through as SearchTerm', async () => {
  const urls = stub({ Items: [] });
  await listLibrary(conn, { type: 'movie', skip: 0, limit: 10, search: 'blade runner' });
  expect(urls[0]).toContain('SearchTerm=blade+runner');
});

it('drops items with no imdb id rather than inventing one', async () => {
  stub({ Items: [
    ITEM,
    { Id: 'jf-2', Name: 'Homemade', ProviderIds: { Tmdb: '9' }, Type: 'Movie' },
    // A junk Imdb value is NOT the same as a missing one: it is truthy, so without the shape
    // check it reaches `meta.id` and renders a catalog row that cannot be opened.
    { Id: 'jf-3', Name: 'Junk id', ProviderIds: { Imdb: 'not-an-id' }, Type: 'Movie' }
  ] });
  const out = await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  // Cinemeta supplies metadata by imdb id; an item without one would render as an empty page.
  expect(out.map((i) => i.jellyfinId)).toEqual(['jf-1']);
});

it('tolerates a missing ProviderIds/ImageTags/ProductionYear without throwing', async () => {
  stub({ Items: [{ Id: 'jf-3', Name: 'Bare', ProviderIds: { Imdb: 'tt9' }, Type: 'Movie' }] });
  const out = await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  expect(out[0]).toMatchObject({ jellyfinId: 'jf-3', year: null, posterTag: null });
});

it('returns an empty list rather than throwing when Jellyfin is unreachable', async () => {
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('returns an empty list on a non-2xx', async () => {
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('returns an empty list on a non-2xx even when the error body is valid JSON', async () => {
  // Guards `if (!res.ok)`: a 500 whose body still parses must not be treated as a catalogue.
  global.fetch = (vi.fn(async () => new Response(
    JSON.stringify({ Items: [ITEM] }), { status: 500, headers: { 'content-type': 'application/json' } }
  )) as any);
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('finds a movie by matching the imdb id locally, NOT by asking Jellyfin to filter', async () => {
  const OTHER = { ...ITEM, Id: 'jf-9', Name: 'Affection', ProviderIds: { Imdb: 'tt33249097' } };
  // Jellyfin 10.11 has no provider-id filter: it ignores one and returns the WHOLE library. This
  // stub reproduces that exactly — every query answers with both titles, in library order.
  const urls = stub({ Items: [OTHER, ITEM] });
  const out = await findByImdb(conn, 'tt0111161', 'movie');
  // The bug this replaces took Items[0] and played 'Affection' for every title in the library.
  expect(out!.jellyfinId).toBe('jf-1');
  expect(out!.name).toBe('Shawshank');
  // No upstream filter is attempted: asking for one is what silently returned everything.
  expect(urls.join('|')).not.toContain('AnyProviderIdEquals');
  expect(urls[0]).toContain('IncludeItemTypes=Movie');
  expect(JSON.stringify(out)).not.toContain('KEY');
});

it('returns null for a title the library does not have, even though the query returns rows', async () => {
  // The regression guard. Jellyfin answers a lookup for an unknown id with the full library; the
  // old code called that a hit. Nothing missing ever looked missing, so the addon never offered
  // to request anything.
  stub({ Items: [{ ...ITEM, Id: 'jf-9', Name: 'Affection', ProviderIds: { Imdb: 'tt33249097' } }] });
  expect(await findByImdb(conn, 'tt0111161', 'movie')).toBeNull();
});

it('pages through a library larger than one request', async () => {
  const page1 = Array.from({ length: 200 }, (_, n) => ({
    ...ITEM, Id: `p1-${n}`, Name: `Filler ${n}`, ProviderIds: { Imdb: `tt1${String(n).padStart(6, '0')}` }
  }));
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    urls.push(String(url));
    const body = urls.length === 1 ? { Items: page1 } : { Items: [ITEM] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as any);
  // Only reachable on the second page — a single-page index would miss it.
  expect((await findByImdb(conn, 'tt0111161', 'movie'))!.jellyfinId).toBe('jf-1');
  expect(urls.length).toBe(2);
  expect(urls[0]).toContain('StartIndex=0');
  expect(urls[1]).toContain('StartIndex=200');
});

it('serves repeat lookups from the index instead of re-fetching', async () => {
  const urls = stub({ Items: [ITEM] });
  await findByImdb(conn, 'tt0111161', 'movie');
  await findByImdb(conn, 'tt0111161', 'movie');
  await findByImdb(conn, 'tt0000000', 'movie');
  expect(urls.length).toBe(1);
});

it('indexes movies and series separately', async () => {
  // A series and a movie can share neither id nor index: asking for one must never answer from
  // the other's library.
  const urls = stub({ Items: [ITEM] });
  await findByImdb(conn, 'tt0111161', 'movie');
  await findByImdb(conn, 'tt0111161', 'series');
  expect(urls.length).toBe(2);
  expect(urls[0]).toContain('IncludeItemTypes=Movie');
  expect(urls[1]).toContain('IncludeItemTypes=Series');
});

it('does not cache an index built from a failed fetch', async () => {
  let call = 0;
  global.fetch = (vi.fn(async () => {
    call++;
    if (call === 1) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ Items: [ITEM] }), { status: 200 });
  }) as any);
  // A blip must not turn into a minute of "you do not own this" for titles that are right there.
  expect(await findByImdb(conn, 'tt0111161', 'movie')).toBeNull();
  expect((await findByImdb(conn, 'tt0111161', 'movie'))!.jellyfinId).toBe('jf-1');
});

it('returns null rather than throwing when Jellyfin is unreachable', async () => {
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await expect(findByImdb(conn, 'tt0111161', 'movie')).resolves.toBeNull();
});

it('returns null when the library does not have the title', async () => {
  stub({ Items: [] });
  expect(await findByImdb(conn, 'tt0000000', 'movie')).toBeNull();
});

it('rejects an imdb id that is not tt-shaped rather than querying', async () => {
  const urls = stub({ Items: [ITEM] });
  // The id arrives from a URL path. A crafted value must not reach the upstream query string.
  for (const bad of ['', 'nope', 'tt', '../x', 'tt1&Foo=bar']) {
    expect(await findByImdb(conn, bad, 'movie')).toBeNull();
  }
  expect(urls).toEqual([]);
});

it('finds an episode by season and episode number', async () => {
  const urls = stub({ Items: [
    { Id: 'ep-1', ParentIndexNumber: 1, IndexNumber: 1 },
    { Id: 'ep-2', ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: 'ep-3', ParentIndexNumber: 2, IndexNumber: 2 }
  ] });
  expect(await findEpisode(conn, 'series-1', 1, 2)).toBe('ep-2');
  expect(urls[0]).toContain('/Shows/series-1/Episodes');
  expect(urls[0]).toContain('season=1');
});

it('returns null for an episode the series does not have', async () => {
  stub({ Items: [{ Id: 'ep-1', ParentIndexNumber: 1, IndexNumber: 1 }] });
  expect(await findEpisode(conn, 'series-1', 1, 99)).toBeNull();
});

it('does not confuse the same episode number in a different season', async () => {
  stub({ Items: [
    { Id: 'ep-s1', ParentIndexNumber: 1, IndexNumber: 5 },
    { Id: 'ep-s2', ParentIndexNumber: 2, IndexNumber: 5 }
  ] });
  expect(await findEpisode(conn, 'series-1', 2, 5)).toBe('ep-s2');
});

it('builds an upstream stream url carrying the api key', () => {
  const u = upstreamStreamUrl(conn, 'jf-1');
  expect(u).toBe('http://jf:8096/Videos/jf-1/stream?static=true&api_key=KEY');
});

it('degrades instead of throwing when the connection url has no scheme', async () => {
  const bad = { ...conn, baseUrl: '192.168.1.5:8096' } as Connection;
  const spy = vi.fn();
  global.fetch = spy as any;
  // `new URL('192.168.1.5:8096/Items')` throws — outside the try/catch this module relies on.
  // A connection saved without a scheme is ordinary and must not 500 the whole addon.
  await expect(listLibrary(bad, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
  await expect(findByImdb(bad, 'tt0111161', 'movie')).resolves.toBeNull();
  await expect(findEpisode(bad, 'series-1', 1, 2)).resolves.toBeNull();
  expect(spy).not.toHaveBeenCalled();
});

it('returns null from upstreamStreamUrl when the connection url has no scheme', () => {
  const bad = { ...conn, baseUrl: '192.168.1.5:8096' } as Connection;
  expect(upstreamStreamUrl(bad, 'jf-1')).toBeNull();
});

it('survives an Items field that is not an array', async () => {
  // An error envelope, or a Jellyfin version that answers differently. Without the isArray guard
  // `.map` throws INSIDE listLibrary, past getJson's catch.
  stub({ Items: { message: 'nope' } });
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
  stub({ Items: 'nope' });
  expect(await findByImdb(conn, 'tt0111161', 'movie')).toBeNull();
  stub({ Items: null });
  expect(await findEpisode(conn, 's1', 1, 2)).toBeNull();
});

it('skips a null or half-formed item rather than emitting undefined fields', async () => {
  stub({ Items: [
    null,
    { ProviderIds: { Imdb: 'tt1' } },                    // no Id, no Name
    { Id: 'jf-9', ProviderIds: { Imdb: 'tt2' } },        // no Name
    { Id: 'jf-1', Name: 'Real', ProviderIds: { Imdb: 'tt0111161' } }
  ] });
  const out = await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  // Without the Id/Name guard these render in the catalogue as literal "undefined".
  expect(out.map((i) => i.jellyfinId)).toEqual(['jf-1']);
});

it('returns empty on a 200 carrying a non-JSON body', async () => {
  global.fetch = (vi.fn(async () => new Response('<html>gateway error</html>', {
    status: 200, headers: { 'Content-Type': 'text/html' }
  })) as any);
  // A reverse proxy answering 200 with an HTML error page is the classic shape here.
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('never writes the api key to the console on a failure', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  await findByImdb(conn, 'tt0111161', 'movie');
  for (const s of [spy, warn, log]) {
    for (const call of s.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('KEY');
      expect(JSON.stringify(call)).not.toContain('api_key');
    }
  }
});

it('does not put NaN into the query string for a non-numeric skip or limit', async () => {
  const urls = stub({ Items: [] });
  await listLibrary(conn, { type: 'movie', skip: NaN, limit: NaN });
  expect(urls[0]).not.toContain('NaN');
  expect(urls[0]).toContain('StartIndex=0');
  expect(urls[0]).toContain('Limit=100');
});
