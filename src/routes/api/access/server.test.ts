import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer } from '$lib/server/identity/consumers';
import { logAccess } from '$lib/server/identity/access-log';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});
import { GET } from './+server';
function call(url: string, user: unknown = { id: 1, email: 'a@b.com' }) {
  return GET({ url: new URL('http://x' + url), locals: { user } } as any);
}
let cId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  cId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  logAccess(db, { consumerId: cId, type: 'login', ip: '10.0.0.1', userAgent: 'Mozilla/5.0 (iPhone)', ts: 100 });
});
afterEach(() => vi.clearAllMocks());

it('returns events with displayName + device, filtered by user', async () => {
  const res = await call(`/api/access?consumerId=${cId}`);
  const body = await res.json();
  expect(body.events[0]).toMatchObject({ type: 'login', displayName: 'Ana', device: 'iPhone', ip: '10.0.0.1' });
});

it('401s without an admin user', async () => {
  await expect(call('/api/access', null)).rejects.toMatchObject({ status: 401 });
});
