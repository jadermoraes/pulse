import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});
import { GET, PUT } from './+server';
const get = () => GET({ } as any);
const put = (body: unknown, user: unknown = { id: 1 }) =>
  PUT({ request: new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), locals: { user } } as any);

beforeEach(() => { db = openDb(':memory:'); migrate(db); });
afterEach(() => vi.clearAllMocks());

it('returns empty contact by default and round-trips a PUT', async () => {
  expect((await (await get()).json()).contact).toBe('');
  await put({ contact: 'admin@home.lan' });
  expect((await (await get()).json()).contact).toBe('admin@home.lan');
});

it('PUT 401s without an admin user', async () => {
  await expect(put({ contact: 'x' }, null)).rejects.toMatchObject({ status: 401 });
});
