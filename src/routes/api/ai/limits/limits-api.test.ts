import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { GET, PUT } from './+server';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); vi.spyOn(dbmod, 'getDb').mockReturnValue(db); });
afterEach(() => vi.restoreAllMocks());

it('GET requires admin and returns defaults', async () => {
  await expect(GET({ locals: {} } as any)).rejects.toMatchObject({ status: 401 });
  const res = await GET({ locals: { user: { id: 1 } } } as any);
  expect((await res.json()).monthlyUsd).toBe(20);
});
it('PUT updates only provided limits and preserves the rest', async () => {
  const res = await PUT({ request: new Request('http://x', { method: 'PUT', body: JSON.stringify({ monthlyUsd: 50 }) }), locals: { user: { id: 1 } } } as any);
  const out = await res.json();
  expect(out.monthlyUsd).toBe(50);
  expect(out.dailyUsd).toBe(5); // untouched default preserved
});
it('PUT requires admin', async () => {
  await expect(PUT({ request: new Request('http://x', { method: 'PUT', body: '{}' }), locals: {} } as any)).rejects.toMatchObject({ status: 401 });
});
