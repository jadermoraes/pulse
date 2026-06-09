import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer, updateConsumer } from '$lib/server/identity/consumers';
import { mintReset, getReset } from '$lib/server/identity/password-reset';
import { _resetStore } from '$lib/server/ratelimit';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});
const setJellyfinPassword = vi.fn();
vi.mock('$lib/server/provisioning/jellyfin', () => ({ setJellyfinPassword: (...a: unknown[]) => setJellyfinPassword(...a) }));
const loginConsumer = vi.fn();
vi.mock('$lib/server/identity/consumer-auth', () => ({ loginConsumer: (...a: unknown[]) => loginConsumer(...a) }));
vi.mock('$lib/server/connections', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/connections');
  return { ...real, listConnections: () => [{ id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'k', options: {}, enabled: true }] };
});

import { POST } from './+server';
function call(body: unknown) {
  return POST({
    request: new Request('http://x', { method: 'POST', headers: { 'user-agent': 'iPhone' }, body: JSON.stringify(body) }),
    cookies: { set: vi.fn() }, getClientAddress: () => '10.0.0.9'
  } as any);
}
let consumerId: number; let token: string;
beforeEach(() => {
  _resetStore(); db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana' });
  token = mintReset(db, consumerId).token;
  setJellyfinPassword.mockReset(); setJellyfinPassword.mockResolvedValue(undefined);
  loginConsumer.mockReset(); loginConsumer.mockResolvedValue('sid-1');
});
afterEach(() => vi.clearAllMocks());

it('sets the password, consumes the token, and auto-logs in', async () => {
  const res = await call({ token, password: 'brandNew123' });
  expect(res.status).toBe(200);
  expect(setJellyfinPassword).toHaveBeenCalledWith(expect.anything(), 'jf-ana', 'brandNew123');
  expect(getReset(db, token)).toBeNull(); // consumed
});

it('rejects an invalid/expired token with 400, password unchanged', async () => {
  await expect(call({ token: 'nope', password: 'brandNew123' })).rejects.toMatchObject({ status: 400 });
  expect(setJellyfinPassword).not.toHaveBeenCalled();
});

it('rejects a weak password with 400', async () => {
  await expect(call({ token, password: 'short' })).rejects.toMatchObject({ status: 400 });
});

it('on Jellyfin failure returns 502 and does NOT consume the token (retryable)', async () => {
  setJellyfinPassword.mockRejectedValue(new Error('jf down'));
  await expect(call({ token, password: 'brandNew123' })).rejects.toMatchObject({ status: 502 });
  expect(getReset(db, token)).not.toBeNull();
});
