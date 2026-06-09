import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { listAccess } from '$lib/server/identity/access-log';
import { _resetStore } from '$lib/server/ratelimit';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});
const loginConsumer = vi.fn();
vi.mock('$lib/server/identity/consumer-auth', () => ({ loginConsumer: (...a: unknown[]) => loginConsumer(...a) }));

import { POST } from './+server';
function call(body: unknown) {
  return POST({
    request: new Request('http://localhost/api/app/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'iPhone' }, body: JSON.stringify(body)
    }),
    cookies: { set: vi.fn() }, getClientAddress: () => '10.1.2.3'
  } as any);
}
beforeEach(() => { _resetStore(); db = openDb(':memory:'); migrate(db); loginConsumer.mockReset(); });
afterEach(() => vi.clearAllMocks());

it('logs login_failed with the attempted username + IP on bad credentials', async () => {
  loginConsumer.mockRejectedValue(new Error('Invalid Jellyfin credentials'));
  await expect(call({ username: 'ana', password: 'wrong' })).rejects.toMatchObject({ status: 401 });
  const ev = listAccess(db, {});
  expect(ev[0]).toMatchObject({ type: 'login_failed', ip: '10.1.2.3', detail: 'ana' });
});
