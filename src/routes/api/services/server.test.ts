/**
 * Route-level tests for GET and PUT /api/services.
 * Hermetic in-memory DB; mocks getDb() via vi.mock.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createConnection } from '$lib/server/connections';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET, PUT } from './+server';

function callGet(user: unknown = { id: 1 }) {
  const event = {
    request: new Request('http://localhost/api/services'),
    locals: { user }
  };
  return GET(event as any);
}

function callPut(body: unknown, user: unknown = { id: 1 }) {
  const event = {
    request: new Request('http://localhost/api/services', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: { user }
  };
  return PUT(event as any);
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/services', () => {
  it('returns 401 without a logged-in user', async () => {
    await expect(callGet(null)).rejects.toMatchObject({ status: 401 });
  });

  it('returns empty links when no connections and no setting', async () => {
    const res = await callGet();
    const body = await res.json();
    expect(body.links).toEqual([]);
  });

  it('derives defaults from enabled connections', async () => {
    createConnection(db, { type: 'jellyfin', name: 'Jellyfin', baseUrl: 'http://jf:8096', secret: null, options: {} });
    const res = await callGet();
    const body = await res.json();
    expect(body.links).toEqual([{ name: 'Jellyfin', url: 'http://jf:8096' }]);
  });
});

describe('PUT /api/services', () => {
  it('returns 401 without a logged-in user', async () => {
    await expect(callPut({ links: [] }, null)).rejects.toMatchObject({ status: 401 });
  });

  it('round-trips a list of links', async () => {
    const links = [
      { name: 'Proxmox', url: 'https://pve.example.com' },
      { name: 'Portainer', url: 'http://portainer:9000' }
    ];
    const putRes = await callPut({ links });
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);

    // GET should now return the curated list.
    const getRes = await callGet();
    const getBody = await getRes.json();
    expect(getBody.links).toEqual(links);
  });

  it('returns 400 when body is missing links array', async () => {
    await expect(callPut({ bad: 'data' })).rejects.toMatchObject({ status: 400 });
  });

  it('filters invalid entries silently', async () => {
    const putRes = await callPut({
      links: [
        { name: 'Good', url: 'https://good.example.com' },
        { name: 'Bad', url: 'not-a-url' },
        { name: '', url: 'https://example.com' }
      ]
    });
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);

    const getRes = await callGet();
    const getBody = await getRes.json();
    expect(getBody.links).toEqual([{ name: 'Good', url: 'https://good.example.com' }]);
  });
});
