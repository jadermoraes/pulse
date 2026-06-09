import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { recordUsage } from '$lib/server/agent/cost';
import { GET } from './+server';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('/api/ai/usage window breakdown', () => {
  it('window breakdown returns per-model rows + totals', async () => {
    recordUsage(db, { model: 'claude-sonnet-4-6', input: 1000, output: 1000 });
    const res = await GET({
      url: new URL('http://x/api/ai/usage?window=30d'),
      locals: { user: { id: 1 } }
    } as any);
    const data = await res.json();
    expect(data.rows[0].model).toBe('claude-sonnet-4-6');
    expect(data.total.cost).toBeGreaterThan(0);
  });

  it('bare GET still returns the cumulative lump + requires admin', async () => {
    await expect(
      GET({ url: new URL('http://x/api/ai/usage'), locals: {} } as any)
    ).rejects.toMatchObject({ status: 401 });
    const res = await GET({
      url: new URL('http://x/api/ai/usage'),
      locals: { user: { id: 1 } }
    } as any);
    expect(await res.json()).toHaveProperty('total');
  });
});
