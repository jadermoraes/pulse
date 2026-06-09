import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer } from '$lib/server/identity/consumers';
import { getReset } from '$lib/server/identity/password-reset';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});
import { POST } from './+server';
function call(body: unknown, user: unknown = { id: 1, email: 'a@b.com' }) {
  return POST({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), locals: { user } } as any);
}
let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => vi.clearAllMocks());

it('mints a reset link for a consumer (admin only)', async () => {
  const res = await call({ id: consumerId });
  const body = await res.json();
  expect(body.link).toMatch(/^\/app\/reset\/[a-f0-9]{48}$/);
  const token = body.link.split('/').pop();
  expect(getReset(db, token)!.consumerId).toBe(consumerId);
});

it('401s without an admin user', async () => {
  await expect(call({ id: consumerId }, null)).rejects.toMatchObject({ status: 401 });
});
