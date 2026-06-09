import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Connection } from '../connections';
import { ensureSeerrUserFromJellyfin, deleteSeerrUser } from './seerr';

const conn: Connection = {
  id: 1, type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'SKEY', options: {}, enabled: true
};
afterEach(() => vi.restoreAllMocks());

function stubFetch(handlers: Array<(url: string, init?: RequestInit) => Response | null>) {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    for (const h of handlers) { const r = h(url, init); if (r) return r; }
    return new Response('unmatched', { status: 500 });
  }));
}

describe('ensureSeerrUserFromJellyfin', () => {
  it('imports a new user, PUTs permissions (no quota), POSTs quota to settings/main', async () => {
    let putBody: any = null;
    let settingsBody: any = null;
    let settingsCalled = false;
    stubFetch([
      // settings/main POST must be matched BEFORE the generic GET on /api/v1/user.
      (u, init) => /\/api\/v1\/user\/99\/settings\/main$/.test(u) && init?.method === 'POST'
        ? (settingsCalled = true, settingsBody = JSON.parse(String(init?.body)), new Response('{}', { status: 200 })) : null,
      // GET /api/v1/user/99 (single user fetch for username/email).
      (u, init) => /\/api\/v1\/user\/99$/.test(u) && (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ id: 99, jellyfinUserId: 'jf-1', username: 'ana', email: 'ana@x' }), { status: 200 }) : null,
      // list → none
      (u, init) => u.includes('/api/v1/user') && (init?.method ?? 'GET') === 'GET' && !u.includes('import') && !/\/user\/\d/.test(u)
        ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : null,
      (u, init) => u.includes('/api/v1/user/import-from-jellyfin') && init?.method === 'POST'
        ? new Response(JSON.stringify([{ id: 99, jellyfinUserId: 'jf-1' }]), { status: 201 }) : null,
      (u, init) => /\/api\/v1\/user\/99$/.test(u) && init?.method === 'PUT'
        ? (putBody = JSON.parse(String(init?.body)), new Response('{}', { status: 200 })) : null
    ]);
    const id = await ensureSeerrUserFromJellyfin(conn, 'jf-1', 32, { movie: 5, tv: 2 });
    expect(id).toBe(99);
    // Permissions on the PUT; quota is NOT sent on the PUT anymore.
    expect(putBody.permissions).toBe(32);
    expect(putBody.movieQuotaLimit).toBeUndefined();
    expect(putBody.tvQuotaLimit).toBeUndefined();
    // Quota goes to settings/main with username+email.
    expect(settingsCalled).toBe(true);
    expect(settingsBody.movieQuotaLimit).toBe(5);
    expect(settingsBody.tvQuotaLimit).toBe(2);
    expect(settingsBody.username).toBe('ana');
    expect(settingsBody.email).toBe('ana@x');
  });

  it('with an empty quota: PUTs permissions but never calls settings/main', async () => {
    let settingsCalled = false;
    stubFetch([
      (u, init) => /\/settings\/main$/.test(u) && init?.method === 'POST'
        ? (settingsCalled = true, new Response('{}', { status: 200 })) : null,
      (u, init) => u.includes('/api/v1/user') && (init?.method ?? 'GET') === 'GET' && !u.includes('import') && !/\/user\/\d/.test(u)
        ? new Response(JSON.stringify({ results: [{ id: 7, jellyfinUserId: 'jf-1' }] }), { status: 200 }) : null,
      (u, init) => /\/api\/v1\/user\/7$/.test(u) && init?.method === 'PUT'
        ? new Response('{}', { status: 200 }) : null
    ]);
    const id = await ensureSeerrUserFromJellyfin(conn, 'jf-1', 32, {});
    expect(id).toBe(7);
    expect(settingsCalled).toBe(false);
  });

  it('is idempotent: reuses an existing seerr user mapped to the Jellyfin id (no import)', async () => {
    const importCall = vi.fn();
    stubFetch([
      (u, init) => u.includes('/api/v1/user') && !u.includes('import') && (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ results: [{ id: 7, jellyfinUserId: 'jf-1' }] }), { status: 200 }) : null,
      (u) => { if (u.includes('import-from-jellyfin')) { importCall(); return new Response('[]', { status: 200 }); } return null; },
      (u, init) => /\/api\/v1\/user\/7$/.test(u) && init?.method === 'PUT' ? new Response('{}', { status: 200 }) : null
    ]);
    const id = await ensureSeerrUserFromJellyfin(conn, 'jf-1', 16, {});
    expect(id).toBe(7);
    expect(importCall).not.toHaveBeenCalled();
  });

  it('throws when the import returns no matching user', async () => {
    stubFetch([
      (u, init) => u.includes('/api/v1/user') && !u.includes('import') && (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ results: [] }), { status: 200 }) : null,
      (u) => u.includes('import-from-jellyfin') ? new Response(JSON.stringify([]), { status: 201 }) : null
    ]);
    await expect(ensureSeerrUserFromJellyfin(conn, 'jf-1', 16, {})).rejects.toThrow(/import|not found/i);
  });
});

describe('deleteSeerrUser', () => {
  it('issues a DELETE to /api/v1/user/{id} with the api key', async () => {
    let seen: { url: string; method?: string; key?: string } | null = null;
    stubFetch([
      (u, init) => /\/api\/v1\/user\/55$/.test(u) && init?.method === 'DELETE'
        ? (seen = { url: u, method: init?.method, key: (init?.headers as any)?.['X-Api-Key'] },
           new Response('{}', { status: 200 }))
        : null
    ]);
    await deleteSeerrUser(conn, 55);
    expect(seen).not.toBeNull();
    expect(seen!.method).toBe('DELETE');
    expect(seen!.key).toBe('SKEY');
  });
});
