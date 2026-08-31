/**
 * Route-level tests for the PUBLIC, completely unauthenticated Stremio addon dispatcher.
 *
 * `/api/_public/**` is exempt from every auth gate in hooks.server.ts, so this handler owns 100%
 * of its own security. Load-bearing properties: an unknown/revoked/malformed token is a 404 and
 * never a 401 (a 401 confirms valid tokens exist for this path); the Jellyfin api key never
 * reaches a response body; Jellyfin being unreachable or unconfigured degrades to an empty
 * catalogue and no streams rather than a 500, because Stremio renders an addon error as a broken
 * row with no explanation.
 * Hermetic in-memory DB; `fetch` stubbed per test.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { mintAddonToken, readAddonToken, revokeAddonToken } from '$lib/server/addon/tokens';
import { _resetLibraryIndex } from '$lib/server/addon/jellyfin-library';
import { createConnection } from '$lib/server/connections';
import { _resetStore } from '$lib/server/ratelimit';
import { __resetRequestLimitState } from '$lib/server/request-limit';

let db: DB;
let consumerId: number;

vi.mock('$lib/server/db', async (orig) => {
  const real = await orig<typeof import('$lib/server/db')>();
  return { ...real, getDb: () => db };
});

beforeEach(() => {
  // Both limiters are module-level in-memory maps that outlive the DB, so they leak between
  // tests: the bad-token cases below would otherwise lock 10.0.0.5 out for every later test.
  _resetStore();
  __resetRequestLimitState();
  // The Jellyfin library index is module-level and keyed on the connection, which every test
  // here recreates with the same id and baseUrl. Without this, one test's stubbed library is
  // still cached when the next one asks — and a test that passes off a neighbour's data is
  // proving nothing.
  _resetLibraryIndex();
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  consumerId = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Jader','active',?)"
  ).run(Date.now()).lastInsertRowid);
  createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096', secret: 'KEY', options: {} });
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

// `request` is part of the real RequestEvent and the play branch reads `Range` off it, so the
// stub event has to carry one or every play test would crash on `undefined.headers`.
const call = (token: string, resource: string, origin = 'http://pulse:3000') =>
  ({ params: { token, resource }, url: new URL(`${origin}/api/_public/addon/${token}/${resource}`),
     request: new Request(`${origin}/api/_public/addon/${token}/${resource}`),
     getClientAddress: () => '10.0.0.5' }) as any;

function stubJf(payload: unknown) {
  global.fetch = (vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as any);
}

it('404s an unknown or malformed token — never 401', async () => {
  mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  for (const bad of ['deadbeef', '', 'x'.repeat(48), '../../etc']) {
    const res = await (GET as any)(call(bad, 'manifest.json'));
    // 401 would confirm that valid tokens exist. The addon must be invisible.
    expect(res.status).toBe(404);
  }
});

it('404s a REVOKED token that is still perfectly well-formed', async () => {
  // The malformed cases above never reach the DB — they die on the shape check. This is the only
  // case that proves a token which passes the shape check is still checked against the store.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  revokeAddonToken(db);
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'manifest.json'));
  expect(res.status).toBe(404);
});

it('serves the manifest for a live token', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'manifest.json'));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resources).toEqual(['catalog', 'stream']);
  expect(res.headers.get('content-type')).toContain('application/json');
});

it('records last use', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'manifest.json'));
  expect(readAddonToken(db)!.lastUsedAt).toEqual(expect.any(Number));
});

it('serves a catalog', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'Shawshank', ProductionYear: 1994,
    ProviderIds: { Imdb: 'tt0111161' }, ImageTags: { Primary: 'tag1' } }] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'))).json();
  expect(body.metas).toHaveLength(1);
  expect(body.metas[0].id).toBe('tt0111161');
});

it('passes search and skip through from the extras segment', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  global.fetch = (vi.fn(async (u: any) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ Items: [] }), { status: 200 });
  }) as any);
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'catalog/movie/pulse-movies/search=blade%20runner&skip=40.json'));
  expect(urls[0]).toContain('SearchTerm=blade+runner');
  expect(urls[0]).toContain('StartIndex=40');
});

it('404s an unknown catalog id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'catalog/movie/someone-elses.json'))).status).toBe(404);
});

it('404s an unsupported stream type', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'stream/channel/tt0111161.json'))).status).toBe(404);
});

it('sends a short cache TTL so a freshly-added title is not invisible', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [] });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect(res.headers.get('cache-control')).toBe('public, max-age=60');
});

it('404s an unsupported catalog type', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'catalog/channel/pulse-movies.json'))).status).toBe(404);
});

it('returns an empty catalog rather than a 500 when jellyfin is down', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).metas).toEqual([]);
});

it('returns a play stream for a title in the library', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'Shawshank', ProviderIds: { Imdb: 'tt0111161' } }] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/tt0111161.json'))).json();
  expect(body.streams).toHaveLength(1);
  expect(body.streams[0].url).toBe(`http://pulse:3000/api/_public/addon/${t}/play/jf-1`);
  // The key must never reach the client.
  expect(JSON.stringify(body)).not.toContain('KEY');
  expect(JSON.stringify(body)).not.toContain('api_key');
});

it('returns a request stream for a title NOT in the library', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/tt0000000.json'))).json();
  // One row per audio preference: Stremio gives an addon no input widget, so the stream list is
  // the only place a choice can be offered at all.
  expect(body.streams).toHaveLength(2);
  expect(body.streams.map((x: any) => x.url)).toEqual([
    `http://pulse:3000/api/_public/addon/${t}/request/movie/tt0000000/ptbr`,
    `http://pulse:3000/api/_public/addon/${t}/request/movie/tt0000000/original`
  ]);
  // Each row has to say which one it is, or the viewer is picking blind between two identical
  // lines.
  expect(body.streams[0].description).not.toBe(body.streams[1].description);
});

it('resolves an episode to its own jellyfin id, not the series', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  let call_ = 0;
  global.fetch = (vi.fn(async () => {
    call_++;
    if (call_ === 1) return new Response(JSON.stringify({ Items: [
      { Id: 'series-1', Name: 'Breaking Bad', ProviderIds: { Imdb: 'tt0903747' } } ] }), { status: 200 });
    return new Response(JSON.stringify({ Items: [
      { Id: 'ep-7', ParentIndexNumber: 2, IndexNumber: 7 } ] }), { status: 200 });
  }) as any);
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/series/tt0903747:2:7.json'))).json();
  expect(body.streams[0].url).toContain('/play/ep-7');
});

it('offers no stream when the series episode is missing from jellyfin', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  let call_ = 0;
  global.fetch = (vi.fn(async () => {
    call_++;
    if (call_ === 1) return new Response(JSON.stringify({ Items: [
      { Id: 'series-1', Name: 'Breaking Bad', ProviderIds: { Imdb: 'tt0903747' } } ] }), { status: 200 });
    return new Response(JSON.stringify({ Items: [] }), { status: 200 });
  }) as any);
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'stream/series/tt0903747:9:9.json'));
  expect(res.status).toBe(200);
  // The series' own item id is not playable; offering it would hand Stremio a dead url.
  expect((await res.json()).streams).toEqual([]);
});

it('offers no stream at all for a malformed id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/not-an-id.json'))).json();
  expect(body.streams).toEqual([]);
});

it('does not 500 on an id with a broken percent escape', async () => {
  // The id segment is caller-supplied and gets percent-decoded. A lone `%` makes
  // decodeURIComponent throw, which on an unauthenticated public route would be a 500.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'stream/movie/%zz.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).streams).toEqual([]);
});

it('serves an empty catalog, not an error, when no jellyfin connection is configured', async () => {
  db.prepare("DELETE FROM connections WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).metas).toEqual([]);
});

it('offers no stream when no jellyfin connection is configured', async () => {
  db.prepare("DELETE FROM connections WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'stream/movie/tt0111161.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).streams).toEqual([]);
});

it('ignores a disabled jellyfin connection', async () => {
  db.prepare("UPDATE connections SET enabled=0 WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'Shawshank', ProviderIds: { Imdb: 'tt0111161' } }] });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect((await res.json()).metas).toEqual([]);
});

it('404s an empty resource', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, ''))).status).toBe(404);
});

it('404s an unknown resource', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  for (const r of ['subtitles/movie/tt1.json', 'manifest.json/extra', 'catalog', 'stream/movie']) {
    expect((await (GET as any)(call(t, r))).status).toBe(404);
  }
});

it('CRITICAL: a bad-token 404 is byte-identical to an unknown-resource 404', async () => {
  // The whole point of answering 404 rather than 401 is that a prober cannot tell "no such token"
  // from "valid token, no such resource". That only holds while the two responses are
  // indistinguishable — body and headers included, not just the status code. Without this,
  // giving the token-404 its own body or header re-opens the oracle with the suite still green.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');

  const badToken = await (GET as any)(call('0'.repeat(48), 'manifest.json'));
  const unknownResource = await (GET as any)(call(t, 'subtitles/movie/tt1.json'));

  for (const res of [badToken, unknownResource]) {
    expect(res.status).toBe(404);
    expect(await res.clone().text()).toBe('');
  }
  expect([...badToken.headers].sort()).toEqual([...unknownResource.headers].sort());
});

// ---------------------------------------------------------------------------
// Task 5: play proxy, poster proxy, request action
// ---------------------------------------------------------------------------

function stubUpstream(handler: (url: string, init: any) => Response) {
  global.fetch = (vi.fn(async (u: any, init: any) => handler(String(u), init)) as any);
}

/** Cinemeta's real shape — `resolveImdbMeta` zod-parses it, so a hand-waved `{title}` would throw
 *  and the request branch would silently swallow it, making the assertions below meaningless. */
const cinemeta = (tmdbId: number | null = 278) =>
  new Response(JSON.stringify({
    meta: { id: 'tt0111161', imdb_id: 'tt0111161', moviedb_id: tmdbId, name: 'Shawshank', type: 'movie' }
  }), { status: 200 });

/** A seerr connection plus the seerr user id `createConsumerRequest` posts as. */
function withSeerr() {
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  db.prepare('UPDATE consumer_users SET seerr_user_id = 7 WHERE id = ?').run(consumerId);
}

it('play proxies the bytes and never reveals the upstream url or key', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  // Jellyfin reflecting the request url back in a header is exactly how the api key escapes if
  // the proxy copies upstream headers wholesale instead of allow-listing them. Assertions against
  // a stub that emits no such header would be vacuous — they would pass with the allow-list gone.
  stubUpstream((u) => new Response('VIDEOBYTES', {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes',
      'X-Upstream-Url': u, 'Set-Cookie': `jellyfin_key=${'KEY'}`
    }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'play/jf-1'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('video/mp4');
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  const echoed = JSON.stringify([...res.headers]);
  expect(echoed).not.toContain('KEY');
  expect(echoed).not.toContain('api_key');
  expect(echoed).not.toContain('jf:8096');
  expect(await res.text()).toBe('VIDEOBYTES');
});

it('CRITICAL: play forwards the Range header and returns 206 with Content-Range', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  let sawRange: string | null = null;
  stubUpstream((_u, init) => {
    sawRange = new Headers(init?.headers).get('range');
    return new Response('BYTES', {
      status: 206,
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 100-104/1000', 'Content-Length': '5' }
    });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=100-104' } })
  });
  // Without this, seeking is impossible and some clients refuse to play at all.
  expect(sawRange).toBe('bytes=100-104');
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 100-104/1000');
});

it('play rejects an item id that is not a plain jellyfin id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  // SSRF guard: a crafted id must never reach the upstream fetch. `jf-1?api_key=stolen` and
  // `jf 1` survive the path split, so they exercise the regex itself rather than the arity check.
  for (const bad of ['../../etc/passwd', 'http://evil/x', 'jf-1?api_key=stolen', 'jf 1']) {
    expect((await (GET as any)(call(t, `play/${bad}`))).status).toBe(404);
  }
  expect(urls).toEqual([]);
});

it('play 404s rather than 500s when jellyfin is unreachable', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'play/jf-1'))).status).toBe(404);
});

it('play 404s when the jellyfin baseUrl cannot be parsed, without fetching', async () => {
  // `upstreamStreamUrl` returns null for a baseUrl saved without a scheme. An unchecked null would
  // be fetched as the literal string "null" — a real outbound request to nowhere, or worse.
  db.prepare("UPDATE connections SET base_url='192.168.1.5:8096' WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'play/jf-1'))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('play 404s when jellyfin answers with an error status', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('nope', { status: 401 }));
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'play/jf-1'))).status).toBe(404);
});

it('poster proxies the image and keeps the api key server-side', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => {
    urls.push(u);
    // Same trap as the play test: the upstream url (which carries api_key) comes back as a header.
    return new Response('JPEGBYTES', {
      status: 200, headers: { 'Content-Type': 'image/png', 'X-Upstream-Url': u }
    });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'poster/jf-1/tag1'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/png');
  // The key is on the upstream request only.
  expect(urls[0]).toContain('api_key=KEY');
  const echoed = JSON.stringify([...res.headers]);
  expect(echoed).not.toContain('KEY');
  expect(await res.text()).toBe('JPEGBYTES');
});

it('poster rejects a crafted item id or tag before fetching', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  // `conn.baseUrl` is string-concatenated here, so an id containing `?` or `#` would rewrite the
  // upstream query — including the api_key parameter.
  for (const r of ['poster/jf-1?x=1/tag1', 'poster/jf-1/tag%201', 'poster/jf-1/tag#1']) {
    expect((await (GET as any)(call(t, r))).status).toBe(404);
  }
  expect(urls).toEqual([]);
});

it('request creates a request for the token consumer and plays the clip', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'request/movie/tt0111161'));
  // 302 to the static clip: production has no `static/` dir (the image copies only `build/`), so
  // reading the file off disk would throw there while passing here.
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('http://pulse:3000/addon/requested.mp4');
  const rows = db.prepare('SELECT * FROM consumer_requests WHERE consumer_id=?').all(consumerId);
  expect(rows).toHaveLength(1);
  expect((rows[0] as any).tmdb_id).toBe(278);
  expect((rows[0] as any).media_type).toBe('movie');
});

it('sends the PT-BR quality profile when the ptbr row is the one selected', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  let posted: any = null;
  stubUpstream((u, init) => {
    if (u.includes('cinemeta')) return cinemeta();
    // Profile discovery: the default radarr, then its profiles. `resolveAudioProfile` matches the
    // profile whose NAME looks PT-BR — id 8 here, mirroring the live radarr.
    if (/\/api\/v1\/service\/radarr\/0$/.test(u)) return new Response(JSON.stringify({
      profiles: [{ id: 7, name: 'Standard 1080p' }, { id: 8, name: 'Standard 1080p (PT-BR)' }]
    }), { status: 200 });
    if (/\/api\/v1\/service\/radarr$/.test(u)) return new Response(
      JSON.stringify([{ id: 0, name: 'Radarr', isDefault: true }]), { status: 200 });
    if (u.includes('/api/v1/request')) {
      posted = JSON.parse(String((init as any)?.body ?? '{}'));
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/tt0111161/ptbr'))).status).toBe(302);
  expect(posted).toMatchObject({ mediaId: 278, profileId: 8, serverId: 0 });
});

it('sends no profile for the original row, leaving seerr its default', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  let posted: any = null;
  stubUpstream((u, init) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) {
      posted = JSON.parse(String((init as any)?.body ?? '{}'));
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/tt0111161/original'))).status).toBe(302);
  expect(posted).not.toBeNull();
  expect(posted.profileId).toBeUndefined();
});

it('404s an audio segment that is neither preference rather than guessing one', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  let posts = 0;
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) { posts++; return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  // Defaulting an unrecognised value to 'original' would hand someone the wrong audio silently.
  // Not in this list: a trailing slash. `filter(Boolean)` drops the empty segment, so
  // `request/movie/tt…/` is the legacy 3-part form and still means seerr's default — which is
  // exactly what a client that cached the old url should get.
  for (const bad of ['ptBR', 'pt-br', 'dublado', 'ptbr/extra', 'original.json']) {
    expect((await (GET as any)(call(t, `request/movie/tt0111161/${bad}`))).status).toBe(404);
  }
  expect(posts).toBe(0);
});

it('CRITICAL: selecting request twice does not stack duplicate requests', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  let posts = 0;
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) { posts++; return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'request/movie/tt0111161'));
  const second = await (GET as any)(call(t, 'request/movie/tt0111161'));
  // Selecting a stream is cheap and repeatable; the request must not be.
  expect(posts).toBe(1);
  expect(second.status).toBe(302);  // still plays the clip
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 1 });
});

it('request still plays the clip when seerr rejects it', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  // Cinemeta resolves fine — it is seerr that fails, which is what this test is about.
  stubUpstream((u) => u.includes('cinemeta') ? cinemeta() : new Response('no', { status: 500 }));
  const { GET } = await import('./+server');
  // The viewer has no channel to read an error in — failing loudly only yields a broken video icon.
  const res = await (GET as any)(call(t, 'request/movie/tt0111161'));
  expect(res.status).toBe(302);
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 0 });
});

it('request still plays the clip when cinemeta cannot resolve the id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  stubUpstream(() => new Response('boom', { status: 500 }));
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/tt0111161'))).status).toBe(302);
});

it('request 404s a malformed id without touching seerr', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('{}', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/not-an-id'))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('request 404s a broken percent escape instead of 500ing', async () => {
  // Bare decodeURIComponent throws a URIError on `%zz`; on this unauthenticated route that is a
  // 500 handed to anyone who can guess the path.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('{}', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/%zz'))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('request accepts a percent-encoded series id — the DECODED value is what is validated', async () => {
  // Task 4's stream branch hands `buildRequestStream` the still-encoded id, so `tt…%3A1%3A2` is
  // what actually arrives here. Validating the raw segment would reject every episode request.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return new Response(JSON.stringify({
      meta: { id: 'tt0903747', imdb_id: 'tt0903747', moviedb_id: 1396, name: 'Breaking Bad', type: 'series' }
    }), { status: 200 });
    if (u.includes('/api/v1/request')) return new Response(JSON.stringify({ id: 2 }), { status: 200 });
    return new Response(JSON.stringify({ name: 'Breaking Bad' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'request/series/tt0903747%3A1%3A2'));
  expect(res.status).toBe(302);
  const rows = db.prepare('SELECT * FROM consumer_requests').all() as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].media_type).toBe('tv');
  expect(rows[0].tmdb_id).toBe(1396);
});

it('request logs the access event against the token consumer', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    return new Response(JSON.stringify({ id: 1, title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'request/movie/tt0111161'));
  const ev = db.prepare("SELECT * FROM access_events WHERE type='request'").all() as any[];
  expect(ev).toHaveLength(1);
  expect(ev[0].consumer_id).toBe(consumerId);
  expect(ev[0].ip).toBe('10.0.0.5');
});

// ---------------------------------------------------------------------------
// Task 5 — fix round 1: guards that were previously deletable-green
// ---------------------------------------------------------------------------

it('play and poster 404 rather than 500 when no jellyfin connection exists', async () => {
  db.prepare("DELETE FROM connections WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  // Without the guard, upstreamStreamUrl(null, …) dereferences conn.baseUrl and throws — a 500
  // from a route that sits outside every auth gate.
  expect((await (GET as any)(call(t, 'play/jf-1'))).status).toBe(404);
  expect((await (GET as any)(call(t, 'poster/jf-1/tag1'))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('poster 404s rather than 500s when jellyfin is unreachable', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'poster/jf-1/tag1'))).status).toBe(404);
});

it('poster 404s an error status instead of caching the error page as an image', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('<html>401 Unauthorized</html>', {
    status: 401, headers: { 'Content-Type': 'text/html' }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'poster/jf-1/tag1'));
  // Without the ok-check this body ships as an image with Cache-Control: public, max-age=86400.
  expect(res.status).toBe(404);
  expect(res.headers.get('cache-control')).toBeNull();
});

it('poster 404s when the jellyfin baseUrl cannot be parsed, without fetching', async () => {
  // Matches play: the url must be built through jf()'s `new URL()` validation, so a schemeless
  // baseUrl declines rather than calling fetch with a string that carries the api key.
  db.prepare("UPDATE connections SET base_url='192.168.1.5:8096' WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'poster/jf-1/tag1'))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('play forwards a 416 instead of flattening it to 404', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response(null, {
    status: 416, headers: { 'Content-Range': 'bytes */1000', 'Content-Type': 'video/mp4' }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=9999999-' } })
  });
  // "That range is unsatisfiable" is a different fact from "the media does not exist"; telling a
  // probing player the latter can abort playback outright.
  expect(res.status).toBe(416);
  expect(res.headers.get('content-range')).toBe('bytes */1000');
});

it('play synthesises Accept-Ranges on a 206 that omits it', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('BYTES', {
    status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-4/1000' }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=0-4' } })
  });
  expect(res.status).toBe(206);
  expect(res.headers.get('accept-ranges')).toBe('bytes');
});

it('play does NOT claim Accept-Ranges when upstream answered 200 to a Range request', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('WHOLEFILE', { status: 200, headers: { 'Content-Type': 'video/mp4' } }));
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=100-104' } })
  });
  // Upstream ignoring the Range means it will not seek. Asserting seek support on its behalf makes
  // the player retry a seek that cannot work.
  expect(res.status).toBe(200);
  expect(res.headers.get('accept-ranges')).toBeNull();
  expect(res.headers.get('content-range')).toBeNull();
});

it('play forwards each of the four allow-listed headers from a 206', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('BYTES', {
    status: 206,
    headers: {
      'Content-Type': 'video/x-matroska', 'Content-Length': '5',
      'Content-Range': 'bytes 100-104/1000', 'Accept-Ranges': 'bytes'
    }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=100-104' } })
  });
  // Each asserted separately: Content-Length carries the 206 framing, and its absence is otherwise
  // invisible because nothing else in the suite reads it.
  expect(res.headers.get('content-type')).toBe('video/x-matroska');
  expect(res.headers.get('content-length')).toBe('5');
  expect(res.headers.get('content-range')).toBe('bytes 100-104/1000');
  expect(res.headers.get('accept-ranges')).toBe('bytes');
});

it('play rejects an over-long item id', async () => {
  // Pins the {1,64} bound: relaxing the regex to `+` would otherwise stay green.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, `play/${'a'.repeat(4096)}`))).status).toBe(404);
  expect((await (GET as any)(call(t, `poster/${'a'.repeat(4096)}/tag1`))).status).toBe(404);
  expect((await (GET as any)(call(t, `poster/jf-1/${'a'.repeat(4096)}`))).status).toBe(404);
  expect(urls).toEqual([]);
});

it('request writes the access event even when getClientAddress throws', async () => {
  // adapter-node throws from getClientAddress() when ADDRESS_HEADER is set and the header is
  // absent. Called after createConsumerRequest, that throw lands in this branch's own catch: a
  // real Seerr request with no audit trail and nothing saying why.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    return new Response(JSON.stringify({ id: 1, title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'request/movie/tt0111161'),
    getClientAddress: () => { throw new Error('Address header "x-forwarded-for" not present'); }
  });
  expect(res.status).toBe(302);
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 1 });
  const ev = db.prepare("SELECT * FROM access_events WHERE type='request'").all() as any[];
  expect(ev).toHaveLength(1);
  expect(ev[0].ip).toBeNull();
});

it('a DECLINED earlier request does not block a second attempt', async () => {
  // The status allow-list exists so a viewer can retry something seerr turned down. Without it the
  // declined row would silently swallow every future selection.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,seerr_request_id,tmdb_id,media_type,title,status,notified,created_at)
     VALUES (?,?,?,?,?,'declined',0,?)`
  ).run(consumerId, 99, 278, 'movie', 'Shawshank', Date.now());
  let posts = 0;
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) { posts++; return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/tt0111161'))).status).toBe(302);
  expect(posts).toBe(1);
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 2 });
});

it("another consumer's pending request does not block this consumer's", async () => {
  // The dedupe is per consumer. Dropping `consumer_id=?` would make one viewer's request suppress
  // everybody else's, and each of them would silently get the clip with nothing recorded.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  const other = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Other','active',?)"
  ).run(Date.now()).lastInsertRowid);
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,seerr_request_id,tmdb_id,media_type,title,status,notified,created_at)
     VALUES (?,?,?,?,?,'pending',0,?)`
  ).run(other, 99, 278, 'movie', 'Shawshank', Date.now());
  let posts = 0;
  stubUpstream((u) => {
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) { posts++; return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/tt0111161'))).status).toBe(302);
  expect(posts).toBe(1);
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests WHERE consumer_id=?').get(consumerId))
    .toEqual({ c: 1 });
});

// ---------------------------------------------------------------------------
// Fix round 1: rate limiting, failure backoff, disabled consumers, bare()
// ---------------------------------------------------------------------------

it('CRITICAL: a DISABLED consumer gets no request filed as them — but the TV still plays', async () => {
  // Disabling someone kills their PWA session instantly (identity/consumer-auth.ts), but the addon
  // token outlives it: ON DELETE CASCADE covers deleting a consumer, not disabling one. Without a
  // status check the household TV keeps spending Jessica's quota and access_events attributes the
  // requests to a disabled account. Play and catalog stay available on purpose — disabling someone
  // should stop them SPENDING, not stop the TV.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  db.prepare("UPDATE consumer_users SET status='disabled' WHERE id=?").run(consumerId);
  const urls: string[] = [];
  stubUpstream((u) => {
    urls.push(u);
    if (u.includes('cinemeta')) return cinemeta();
    return new Response(JSON.stringify({ id: 1, title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'request/movie/tt0111161'));
  expect(res.status).toBe(302);
  expect(urls.filter((u) => u.includes('/api/v1/request'))).toEqual([]);
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 0 });
  expect(db.prepare("SELECT COUNT(*) c FROM access_events WHERE type='request'").get()).toEqual({ c: 0 });
});

it('rate-limits the request action: the 11th in a window still 302s but never reaches seerr', async () => {
  // `request` writes to Seerr, so it gets a ceiling — 10 per 60s on the token. `play`/`poster`
  // deliberately do NOT: one playback session issues many Range requests and throttling those
  // breaks seeking. On refusal the viewer still gets the clip; they have no channel to read an
  // error in, and the idempotency guard already makes repeats cheap.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  withSeerr();
  const urls: string[] = [];
  stubUpstream((u) => {
    urls.push(u);
    if (u.includes('cinemeta')) return cinemeta();
    if (u.includes('/api/v1/request')) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  for (let i = 0; i < 10; i++) await (GET as any)(call(t, 'request/movie/tt0111161'));
  const before = urls.length;
  // A DIFFERENT title, so it is the limiter stopping this one and not the idempotency guard.
  const res = await (GET as any)(call(t, 'request/movie/tt0068646'));
  expect(res.status).toBe(302);
  expect(urls.length).toBe(before); // no cinemeta lookup, no seerr POST — nothing upstream at all
});

it('does NOT rate-limit play: a seeking player issues far more than ten Range requests', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('VIDEOBYTES', {
    status: 206, headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-9/100' }
  }));
  const { GET } = await import('./+server');
  for (let i = 0; i < 30; i++) {
    const res = await (GET as any)(call(t, 'play/jf-1'));
    expect(res.status).toBe(206);
  }
});

it('CRITICAL: a locked-out ip gets a 404 byte-identical to an unknown-token 404', async () => {
  // The URL is the whole credential, so an unthrottled 404 makes this route a free brute-force
  // oracle. The backoff must not become an oracle of its own: a locked-out caller sees exactly the
  // same bare 404 as "no such token" and "no such resource".
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const unknownToken = await (GET as any)(call('0'.repeat(48), 'manifest.json'));
  for (let i = 0; i < 5; i++) await (GET as any)(call('1'.repeat(48), 'manifest.json'));

  // Even the LIVE token is now refused, and refused identically.
  const locked = await (GET as any)(call(t, 'manifest.json'));
  expect(locked.status).toBe(404);
  expect(await locked.clone().text()).toBe('');
  expect([...locked.headers].sort()).toEqual([...unknownToken.headers].sort());
});

it('does not lock out when getClientAddress throws', async () => {
  // adapter-node throws from getClientAddress() when ADDRESS_HEADER is set and the header is
  // absent. A throw there must not become a 500, and a null address simply means no per-ip backoff.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const boom = { getClientAddress: () => { throw new Error('Address header not present'); } };
  for (let i = 0; i < 6; i++) {
    expect((await (GET as any)({ ...call('0'.repeat(48), 'manifest.json'), ...boom })).status).toBe(404);
  }
  expect((await (GET as any)({ ...call(t, 'manifest.json'), ...boom })).status).toBe(200);
});

it('strips only a TRAILING .json — a search term containing ".json" survives intact', async () => {
  // `bare()`'s regex is anchored. Unanchored it would eat the first `.json` anywhere in the
  // segment and silently mangle what the viewer typed into Stremio's search box.
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response(JSON.stringify({ Items: [] }), { status: 200 }); });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'catalog/movie/pulse-movies/search=a.jsonx.json'));
  expect(urls[0]).toContain('SearchTerm=a.jsonx');
});

// --- CORS ---
// Stremio fetches the addon from its own origin. Without these headers the browser discards the
// response before the client sees it, and the user gets a bare "Failed to fetch" while the server
// log shows a clean 200. This was missed entirely in the design and only surfaced on a real client.

it('CRITICAL: every addon response carries Access-Control-Allow-Origin', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'S', ProviderIds: { Imdb: 'tt0111161' } }] });
  const { GET } = await import('./+server');
  for (const resource of ['manifest.json', 'catalog/movie/pulse-movies.json', 'stream/movie/tt0111161.json']) {
    const res = await (GET as any)(call(t, resource));
    expect(res.headers.get('access-control-allow-origin'), resource).toBe('*');
  }
});

it('a rejected request still carries CORS, so the client sees the 404 rather than a fetch error', async () => {
  const { GET } = await import('./+server');
  const res = await (GET as any)(call('0'.repeat(48), 'manifest.json'));
  expect(res.status).toBe(404);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
});

it('answers the CORS preflight instead of 405ing it', async () => {
  const { OPTIONS } = await import('./+server');
  const res = await (OPTIONS as any)(call('whatever', 'manifest.json'));
  // Without an OPTIONS handler SvelteKit answers 405 and the browser never issues the GET.
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('access-control-allow-methods')).toContain('GET');
});
