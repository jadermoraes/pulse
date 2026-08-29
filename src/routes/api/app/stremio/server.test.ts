import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { getCredential, saveCredential } from '$lib/server/consumer/spoke-credentials';
import { __resetRequestLimitState } from '$lib/server/request-limit';

let db: DB;
let consumerId: number;
beforeEach(() => {
  __resetRequestLimitState();
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,allow_list,created_at) VALUES (2,?,?,?)')
    .run('viewer', JSON.stringify(['watchlist']), Date.now());
  const info = db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Jader','active',?)"
  ).run(Date.now());
  consumerId = Number(info.lastInsertRowid);
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

async function handlers() {
  vi.doMock('$lib/server/db', () => ({ getDb: () => db, openDb, migrate }));
  return await import('./+server');
}

it('rejects an unauthenticated caller on every verb', async () => {
  const { GET, POST, DELETE } = await handlers();
  await expect(GET({ locals: {} } as any)).rejects.toMatchObject({ status: 401 });
  await expect(POST({ locals: {}, request: new Request('http://x', { method: 'POST', body: '{}' }) } as any))
    .rejects.toMatchObject({ status: 401 });
  await expect(DELETE({ locals: {} } as any)).rejects.toMatchObject({ status: 401 });
});

it('a successful login stores the authKey encrypted and never the password', async () => {
  global.fetch = (vi.fn(async () => new Response(JSON.stringify({ result: { authKey: 'ak-1' } }), { status: 200 })) as any);
  const { POST } = await handlers();
  const res = await POST({
    locals: { consumer: { id: consumerId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ email: 'a@b.c', password: 'hunter2' }) })
  } as any);
  expect(await res.json()).toMatchObject({ ok: true });
  expect(getCredential(db, consumerId, 'stremio')?.secret).toBe('ak-1');
  const raw = db.prepare('SELECT secret FROM spoke_credentials WHERE consumer_id=?').get(consumerId) as any;
  expect(raw.secret).not.toBe('ak-1');
  const dump = JSON.stringify(db.prepare('SELECT * FROM spoke_credentials').all());
  expect(dump).not.toContain('hunter2');
});

it('a bad login is reported without storing anything', async () => {
  global.fetch = (vi.fn(async () => new Response(
    JSON.stringify({ error: { code: 2, message: 'User not found' } }), { status: 200 }
  )) as any);
  const { POST } = await handlers();
  await expect(POST({
    locals: { consumer: { id: consumerId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ email: 'a@b.c', password: 'x' }) })
  } as any)).rejects.toMatchObject({ status: 400 });
  expect(getCredential(db, consumerId, 'stremio')).toBeNull();
});

it('delete unlinks only this consumer', async () => {
  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  const { DELETE } = await handlers();
  await DELETE({ locals: { consumer: { id: consumerId } } } as any);
  expect(getCredential(db, consumerId, 'stremio')).toBeNull();
});

it('a consumer lacking the watchlist capability gets 403', async () => {
  db.prepare('INSERT INTO roles(id,name,allow_list,created_at) VALUES (3,?,?,?)')
    .run('no-watchlist', JSON.stringify([]), Date.now());
  const info = db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (3,'NoAccess','active',?)"
  ).run(Date.now());
  const noAccessId = Number(info.lastInsertRowid);
  global.fetch = (vi.fn(async () => new Response(JSON.stringify({ result: { authKey: 'ak-1' } }), { status: 200 })) as any);
  const { POST } = await handlers();
  await expect(POST({
    locals: { consumer: { id: noAccessId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ email: 'a@b.c', password: 'hunter2' }) })
  } as any)).rejects.toMatchObject({ status: 403 });
  expect(getCredential(db, noAccessId, 'stremio')).toBeNull();
});

it('a sixth link attempt inside the window gets 429', async () => {
  global.fetch = (vi.fn(async () => new Response(
    JSON.stringify({ error: { code: 2, message: 'User not found' } }), { status: 200 }
  )) as any);
  const { POST } = await handlers();
  const attempt = () => POST({
    locals: { consumer: { id: consumerId } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ email: 'a@b.c', password: 'x' }) })
  } as any);
  for (let i = 0; i < 5; i++) {
    await expect(attempt()).rejects.toMatchObject({ status: 400 });
  }
  await expect(attempt()).rejects.toMatchObject({ status: 429 });
});
