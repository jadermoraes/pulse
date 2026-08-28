import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { getCredential, saveCredential } from '$lib/server/consumer/spoke-credentials';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer } from '$lib/server/identity/consumers';

let db: DB;
// spoke_credentials.consumer_id is FK'd to consumer_users(id) with foreign_keys=ON, so tests
// that write a credential need a real consumer row. migrate() auto-seeds the Admin role at
// id=1, so the test role below lands at id=2.
let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, {
    name: 'Member', allowList: [], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {}
  });
  consumerId = createConsumer(db, { roleId, displayName: 'Viewer', language: 'en' });
  process.env.PULSE_TRAKT_CLIENT_ID = 'cid';
  process.env.PULSE_TRAKT_CLIENT_SECRET = 'csec';
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

async function handlers() {
  vi.doMock('$lib/server/db', () => ({ getDb: () => db, openDb, migrate }));
  return await import('./+server');
}

it('rejects an unauthenticated caller', async () => {
  const { GET } = await handlers();
  await expect(GET({ locals: {} } as any)).rejects.toMatchObject({ status: 401 });
});

it('start returns the user code and verification url', async () => {
  global.fetch = (vi.fn(async () => new Response(JSON.stringify({
    device_code: 'dc', user_code: 'ABC123',
    verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5
  }), { status: 200 })) as any);

  const { POST } = await handlers();
  const res = await POST({
    locals: { consumer: { id: consumerId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'start' }) })
  } as any);
  expect(await res.json()).toMatchObject({ userCode: 'ABC123', verificationUrl: 'https://trakt.tv/activate' });
});

it('a successful poll stores the credential', async () => {
  global.fetch = (vi.fn(async () => new Response(JSON.stringify({
    access_token: 'at', refresh_token: 'rt', expires_in: 7200
  }), { status: 200 })) as any);

  const { POST } = await handlers();
  const res = await POST({
    locals: { consumer: { id: consumerId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'poll', deviceCode: 'dc' }) })
  } as any);
  expect(await res.json()).toMatchObject({ status: 'ok' });
  expect(getCredential(db, consumerId, 'trakt')?.secret).toBe('at');
});

it('delete unlinks', async () => {
  saveCredential(db, { consumerId, spoke: 'trakt', secret: 'at' });
  const { DELETE } = await handlers();
  await DELETE({ locals: { consumer: { id: consumerId } } } as any);
  expect(getCredential(db, consumerId, 'trakt')).toBeNull();
});
