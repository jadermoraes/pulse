import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { listMyRequests, cancelMyRequest } from './my-requests';

let db: DB;
function seerr() { return createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'KEY', options: {} }); }
afterEach(() => vi.unstubAllGlobals());

it('listMyRequests returns only the given user\'s requests with normalized status', async () => {
  db = openDb(':memory:'); migrate(db); seerr();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [
    { id: 1, status: 2, media: { status: 5, tmdbId: 100, mediaType: 'tv' }, requestedBy: { id: 7 } },
    { id: 2, status: 1, media: { status: 2, tmdbId: 200, mediaType: 'movie' }, requestedBy: { id: 9 } }
  ] }), { status: 200 })));
  const out = await listMyRequests(db, 7);
  expect(out).toHaveLength(1);
  expect(out[0]).toMatchObject({ requestId: 1, tmdbId: 100, status: 'available' });
});

it('cancelMyRequest DELETEs an owned request', async () => {
  db = openDb(':memory:'); migrate(db); seerr();
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: 1, requestedBy: { id: 7 } }), { status: 200 });
  }));
  const r = await cancelMyRequest(db, 7, { requestId: 1 });
  expect(r.ok).toBe(true);
  expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/v1/request/1'))).toBe(true);
});

it('cancelMyRequest REFUSES a request not owned by the user and does not DELETE', async () => {
  db = openDb(':memory:'); migrate(db); seerr();
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ id: 1, requestedBy: { id: 999 } }), { status: 200 });
  }));
  const r = await cancelMyRequest(db, 7, { requestId: 1 });
  expect(r.ok).toBe(false);
  expect(calls.every((c) => c.method !== 'DELETE')).toBe(true);
});
