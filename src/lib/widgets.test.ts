import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from './server/db';
import { createConnection } from './server/connections';
import { resolveWidget } from './widgets';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
afterEach(() => vi.restoreAllMocks());

describe('resolveWidget', () => {
  it('errors for unknown connection', async () => {
    const r = await resolveWidget(db, 999, 'recentlyAdded');
    expect(r.ok).toBe(false);
  });
  it('routes to the integration widget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200,
      json: async () => ({ Items: [{ Name: 'X', Id: '1', ProductionYear: 2026, Type: 'Movie' }] }) } as Response)));
    const id = createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://x:8096', secret: 'k', options: {} });
    const r = await resolveWidget(db, id, 'recentlyAdded');
    expect(r.ok).toBe(true);
  });
});
