import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectionApiRequest, pvePassthrough } from './api-passthrough';

const conn = (type: string, extra = {}) => ({ id: 1, type, name: type, baseUrl: 'http://svc', secret: 'KEY', options: {}, enabled: true, ...extra }) as any;
afterEach(() => vi.unstubAllGlobals());

it('radarr/sonarr/seerr: GET sends X-Api-Key + path + query, returns {status,data}', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, method: init.method ?? 'GET' });
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }));
  const r = await connectionApiRequest(conn('radarr'), { method: 'GET', path: '/api/v3/movie', query: { term: 'x' } });
  expect(calls[0].url).toBe('http://svc/api/v3/movie?term=x');
  expect(calls[0].headers['X-Api-Key']).toBe('KEY');
  expect(r).toEqual({ status: 200, data: { ok: 1 } });
});

it('POST sends body + returns non-2xx status without throwing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'bad' }), { status: 400 })));
  const r = await connectionApiRequest(conn('sonarr'), { method: 'POST', path: '/api/v3/series', body: { title: 'X' } });
  expect(r.status).toBe(400);
  expect(r.data).toEqual({ error: 'bad' });
});

it('unsupported connection type → structured error, no throw', async () => {
  const r = await connectionApiRequest(conn('weirdservice'), { method: 'GET', path: '/x' });
  expect(r.status).toBe(0);
  expect((r.data as any).error).toMatch(/not support/i);
});

it('jellyfin uses X-Emby-Token header', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, headers: init.headers }); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('jellyfin'), { method: 'GET', path: '/Items', query: { searchTerm: 'noir' } });
  expect(calls[0].url).toBe('http://svc/Items?searchTerm=noir');
  expect(calls[0].headers['X-Emby-Token']).toBe('KEY');
});
it('plex uses X-Plex-Token header + Accept json', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ headers: init.headers }); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('plex'), { method: 'GET', path: '/library/sections' });
  expect(calls[0].headers['X-Plex-Token']).toBe('KEY');
  expect(calls[0].headers['Accept']).toBe('application/json');
});
it('tautulli puts the apikey in the query string', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('tautulli'), { method: 'GET', path: '/api/v2', query: { cmd: 'get_activity' } });
  const u = new URL(calls[0]);
  expect(u.searchParams.get('apikey')).toBe('KEY');
  expect(u.searchParams.get('cmd')).toBe('get_activity');
});
it('jellyfin POST sends body + Content-Type, GET omits Content-Type', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ headers: init.headers, body: init.body, method: init.method }); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('jellyfin'), { method: 'POST', path: '/Users/AuthenticateByName', body: { Username: 'admin', Pw: 'secret' } });
  expect(calls[0].headers['Content-Type']).toBe('application/json');
  expect(JSON.parse(calls[0].body)).toEqual({ Username: 'admin', Pw: 'secret' });
  // GET must not carry Content-Type
  calls.length = 0;
  await connectionApiRequest(conn('jellyfin'), { method: 'GET', path: '/Items' });
  expect(calls[0].headers['Content-Type']).toBeUndefined();
});
it('jellystat uses x-api-token header', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push({ url, headers: init.headers }); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('jellystat'), { method: 'GET', path: '/api/getHistory' });
  expect(calls[0].url).toBe('http://svc/api/getHistory');
  expect(calls[0].headers['x-api-token']).toBe('KEY');
});

// qBittorrent: username lives in conn.options.username, password in conn.secret.
// The integration's login() POSTs to /api/v2/auth/login and reuses the returned cookie.
it('qbittorrent logs in then calls with the SID cookie', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init?.headers ?? {} });
    if (url.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } });
    return new Response(JSON.stringify([]), { status: 200 });
  }));
  // id:0 so the integration's sidCache doesn't persist between tests.
  await connectionApiRequest(conn('qbittorrent', { id: 0, secret: 'pw', options: { username: 'admin' } }), { method: 'GET', path: '/api/v2/torrents/info' });
  expect(calls.some((c) => c.url.includes('/auth/login'))).toBe(true);
  const apiCall = calls.find((c) => c.url.includes('/torrents/info'));
  expect(String(apiCall.headers.Cookie ?? apiCall.headers.cookie ?? '')).toContain('SID=abc');
});

it('qbittorrent POST form-encodes the body (qBit needs form, not JSON)', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    if (url.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } });
    return new Response('Ok.', { status: 200 });
  }));
  await connectionApiRequest(conn('qbittorrent', { id: 0, secret: 'pw', options: { username: 'admin' } }), {
    method: 'POST', path: '/api/v2/torrents/add', body: { urls: 'magnet:?xt=urn:btih:ABC', savepath: '/data/x' }
  });
  const add = calls.find((c) => c.url.includes('/torrents/add'));
  expect(add.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  expect(String(add.body)).not.toContain('{'); // form-encoded, not a JSON object
  const params = new URLSearchParams(add.body);
  expect(params.get('urls')).toBe('magnet:?xt=urn:btih:ABC');
  expect(params.get('savepath')).toBe('/data/x');
});

it('qbittorrent accepts a JSON-string body and still form-encodes it', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    if (url.includes('/auth/login')) return new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=abc; path=/' } });
    return new Response('Ok.', { status: 200 });
  }));
  await connectionApiRequest(conn('qbittorrent', { id: 0, secret: 'pw', options: { username: 'admin' } }), {
    method: 'POST', path: '/api/v2/torrents/add', body: '{"urls":"magnet:?xt=urn:btih:XYZ"}'
  });
  const add = calls.find((c) => c.url.includes('/torrents/add'));
  expect(new URLSearchParams(add.body).get('urls')).toBe('magnet:?xt=urn:btih:XYZ');
});

// Proxmox uses its own node:https transport (rejectUnauthorized:false), not global fetch,
// so we inject a transport mock the way the proxmox integration tests do.
it('proxmox sends the PVEAPIToken Authorization header', async () => {
  const calls: any[] = [];
  const transport = {
    request: vi.fn(async (opts: any) => { calls.push(opts.headers); return { status: 200, body: '{"data":[]}' }; })
  };
  const r = await pvePassthrough(
    conn('proxmox', { secret: 'uuid', options: { tokenId: 'user@pam!tok' } }),
    { method: 'GET', path: '/api2/json/nodes' },
    transport as any
  );
  expect(String(calls[0].Authorization ?? '')).toContain('PVEAPIToken=');
  expect(calls[0].Authorization).toBe('PVEAPIToken=user@pam!tok=uuid');
  expect(r.status).toBe(200);
});

it('does NOT double-encode a JSON-string body (sonarr command 400 bug)', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => { calls.push(init.body); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('sonarr'), { method: 'POST', path: '/api/v3/command', body: '{"name":"SeriesSearch","seriesId":1}' });
  // the model passed body as a JSON STRING — it must be sent as-is, not stringified again
  expect(calls[0]).toBe('{"name":"SeriesSearch","seriesId":1}');
  expect(JSON.parse(calls[0])).toEqual({ name: 'SeriesSearch', seriesId: 1 });
});

it('still JSON-encodes an object body normally', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => { calls.push(init.body); return new Response('{}', { status: 200 }); }));
  await connectionApiRequest(conn('sonarr'), { method: 'POST', path: '/api/v3/series', body: { title: 'X' } });
  expect(JSON.parse(calls[0])).toEqual({ title: 'X' });
});
