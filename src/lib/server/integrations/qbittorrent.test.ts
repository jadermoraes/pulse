import { describe, it, expect, vi, afterEach } from 'vitest';
import { qbittorrent, __resetSidCache } from './qbittorrent';
import type { Connection } from '../connections';

const conn: Connection = { id: 1, type: 'qbittorrent', name: 'qBit',
  baseUrl: 'http://qbit:8080', secret: 'pass', options: { username: 'admin' }, enabled: true };

afterEach(() => { vi.restoreAllMocks(); __resetSidCache(); });

// Builds a fetch mock. `state.authed` toggles 403→200 to exercise re-auth.
function makeFetch(handlers: {
  login?: () => Partial<Response> & { headers?: any };
  byPath: (path: string, authed: boolean) => Partial<Response>;
}) {
  const state = { authed: true };
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/v2/auth/login') {
      state.authed = true;
      const r = handlers.login?.() ?? {
        ok: true, status: 204,
        text: async () => '',
        headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=ABC123; path=/' : null) }
      };
      return r as unknown as Response;
    }
    const base = handlers.byPath(path, state.authed);
    return {
      ok: base.status === 200,
      status: base.status ?? 200,
      json: base.json,
      text: base.text ?? (async () => ''),
      headers: { get: () => null },
      ...base
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { fn, state };
}

describe('qbittorrent integration', () => {
  it('captures QBT_SID_8080 cookie and sends it verbatim on subsequent requests', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      const path = new URL(url).pathname;
      if (path === '/api/v2/auth/login') {
        // Simulate successful 204 login (empty body, session cookie)
        return { ok: true, status: 204, text: async () => '',
          headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=MYSESSION; path=/; HttpOnly' : null) } } as any;
      }
      return { ok: true, status: 200, json: async () => ({ dl_info_speed: 0, up_info_speed: 0 }) } as any;
    }));
    const r = await qbittorrent.widgets.transfers(conn);
    expect(r.ok).toBe(true);
    // The authed request must carry the exact "QBT_SID_8080=MYSESSION" cookie
    const dataCall = calls.find((c) => String(c[0]).includes('/transfer/info'));
    expect(dataCall).toBeTruthy();
    expect(String(dataCall[1].headers.Cookie)).toBe('QBT_SID_8080=MYSESSION');
  });

  it('testConnection logs in then reads app version', async () => {
    makeFetch({ byPath: (p) => p === '/api/v2/app/version'
      ? { status: 200, text: async () => 'v4.6.2' } : { status: 404 } });
    const r = await qbittorrent.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('v4.6.2');
    // login must have been called with form body containing username+password
    const loginCall = (fetch as any).mock.calls.find((c: any) => String(c[0]).includes('/auth/login'));
    expect(loginCall).toBeTruthy();
    expect(String(loginCall[1].body)).toContain('username=admin');
    expect(String(loginCall[1].body)).toContain('password=pass');
  });

  it('testConnection fails when login returns Fails.', async () => {
    makeFetch({
      login: () => ({ ok: true, status: 200, text: async () => 'Fails.',
        headers: { get: () => null } }) as any,
      byPath: () => ({ status: 200, text: async () => 'v4.6.2' })
    });
    expect((await qbittorrent.testConnection(conn)).ok).toBe(false);
  });

  it('testConnection succeeds with 204 empty-body login (no Ok. body)', async () => {
    // Some qBittorrent instances return HTTP 204 with empty body on successful login
    makeFetch({
      login: () => ({ ok: true, status: 204, text: async () => '',
        headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=SID204; path=/' : null) } }) as any,
      byPath: (p) => p === '/api/v2/app/version'
        ? { status: 200, text: async () => 'v5.0.0' } : { status: 404 }
    });
    const r = await qbittorrent.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('v5.0.0');
  });

  it('testConnection fails when login succeeds but no session cookie is returned', async () => {
    makeFetch({
      login: () => ({ ok: true, status: 200, text: async () => 'Ok.',
        headers: { get: () => null } }) as any,
      byPath: () => ({ status: 200, text: async () => 'v4.6.2' })
    });
    expect((await qbittorrent.testConnection(conn)).ok).toBe(false);
  });

  it('transfers maps dl/up speed', async () => {
    makeFetch({ byPath: (p) => p === '/api/v2/transfer/info'
      ? { status: 200, json: async () => ({ dl_info_speed: 1048576, up_info_speed: 524288 }) }
      : { status: 404 } });
    const r = await qbittorrent.widgets.transfers(conn);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ dlSpeed: 1048576, upSpeed: 524288 });
  });

  it('torrents maps name/progress/state/speed', async () => {
    makeFetch({ byPath: (p) => p === '/api/v2/torrents/info'
      ? { status: 200, json: async () => ([{ name: 'Apex', progress: 0.5, state: 'downloading', dlspeed: 1000, hash: 'h1' }]) }
      : { status: 404 } });
    const r = await qbittorrent.widgets.torrents(conn);
    expect(r.ok).toBe(true);
    const t = (r.data as any[])[0];
    expect(t).toMatchObject({ id: 'h1', name: 'Apex', state: 'downloading', dlSpeed: 1000 });
    expect(t.progress).toBe(50);
  });

  it('re-authenticates once on a 403 then succeeds', async () => {
    let first = true;
    makeFetch({ byPath: (p) => {
      if (p !== '/api/v2/transfer/info') return { status: 404 };
      if (first) { first = false; return { status: 403, json: async () => ({}) }; }
      return { status: 200, json: async () => ({ dl_info_speed: 1, up_info_speed: 2 }) };
    } });
    const r = await qbittorrent.widgets.transfers(conn);
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ dlSpeed: 1, upSpeed: 2 });
    const loginCalls = (fetch as any).mock.calls.filter((c: any) => String(c[0]).includes('/auth/login'));
    expect(loginCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('qbittorrent actions', () => {
  it('pause POSTs hashes to /torrents/pause with the SID cookie', async () => {
    const calls: any[] = [];
    (fetch as any);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      const path = new URL(url).pathname;
      if (path === '/api/v2/auth/login') {
        return { ok: true, status: 204, text: async () => '',
          headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=ABC; path=/' : null) } } as any;
      }
      return { ok: true, status: 200, text: async () => '' } as any;
    }));
    const r = await qbittorrent.actions!.pause.run(conn, { hash: 'h1' });
    expect(r.ok).toBe(true);
    const call = calls.find((c) => String(c[0]).includes('/torrents/pause'));
    expect(call).toBeTruthy();
    expect(String(call[1].body)).toContain('hashes=h1');
    expect(String(call[1].headers.Cookie)).toBe('QBT_SID_8080=ABC');
  });

  it('delete POSTs hashes + deleteFiles=true to /torrents/delete', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      if (new URL(url).pathname === '/api/v2/auth/login') {
        return { ok: true, status: 204, text: async () => '',
          headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=ABC; path=/' : null) } } as any;
      }
      return { ok: true, status: 200, text: async () => '' } as any;
    }));
    const r = await qbittorrent.actions!.delete.run(conn, { hash: 'h1' });
    expect(r.ok).toBe(true);
    const call = calls.find((c) => String(c[0]).includes('/torrents/delete'));
    expect(String(call[1].body)).toContain('hashes=h1');
    expect(String(call[1].body)).toContain('deleteFiles=true');
  });
});

describe('qbittorrent sid cache nit', () => {
  it('does not cache a SID for an unsaved (id<=0) connection', async () => {
    const testConn = { ...conn, id: 0 };
    let logins = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/api/v2/auth/login') {
        logins++;
        return { ok: true, status: 204, text: async () => '',
          headers: { get: (h: string) => (h.toLowerCase() === 'set-cookie' ? 'QBT_SID_8080=Z; path=/' : null) } } as any;
      }
      return { ok: true, status: 200, text: async () => 'v4.6.2' } as any;
    }));
    await qbittorrent.testConnection(testConn);
    await qbittorrent.testConnection(testConn);
    // each test logs in fresh (login + testConnection's own login) — no cross-call SID reuse for id<=0
    expect(logins).toBeGreaterThanOrEqual(2);
  });
});
