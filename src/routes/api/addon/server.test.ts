/**
 * Route-level tests for the Stremio addon admin API.
 *
 * Load-bearing properties: every verb is admin-gated (the token in the URL is a bearer credential
 * for the whole library, so an unauthenticated mint would be a full compromise); minting validates
 * `consumerId` against the live roster (a token attributed to a ghost consumer 404s forever with
 * no explanation); minting revokes the previous token, so "regenerate" is real and not theatre.
 * Hermetic in-memory DB.
 */
import { it, expect, beforeEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { readAddonToken, resolveAddonToken, touchAddonToken } from '$lib/server/addon/tokens';

let db: DB;
let a: number;
let b: number;

vi.mock('$lib/server/db', async (orig) => {
  const real = await orig<typeof import('$lib/server/db')>();
  return { ...real, getDb: () => db };
});

beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const mk = (n: string) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,?,'active',?)"
  ).run(n, Date.now()).lastInsertRowid);
  a = mk('Jader'); b = mk('Jessica');
});

const admin = { user: { id: 1 } } as any;
const anon = { user: null } as any;
const req = (body: unknown) => new Request('http://x/api/addon', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

it('rejects a caller with no admin session on every verb', async () => {
  const { GET, POST, DELETE } = await import('./+server');
  // Each body is one that WOULD succeed for an admin, so deleting a guard turns the call into a
  // 200 and fails this test — rather than throwing some other status that still "matches" 401.
  for (const call of [
    () => (GET as any)({ locals: anon }),
    () => (POST as any)({ locals: anon, request: req({ consumerId: a }) }),
    () => (DELETE as any)({ locals: anon })
  ]) {
    await expect(call()).rejects.toMatchObject({ status: 401 });
  }
  // And nothing leaked through as a side effect of the rejected POST.
  expect(readAddonToken(db)).toBeNull();
});

it('reports the unminted state with the consumer roster', async () => {
  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(false);
  expect(body.token).toBeNull();
  expect(body.consumerId).toBeNull();
  expect(body.label).toBeNull();
  expect(body.createdAt).toBeNull();
  expect(body.lastUsedAt).toBeNull();
  expect(body.consumers.map((c: any) => c.displayName).sort()).toEqual(['Jader', 'Jessica']);
});

it('mints a token attributed to the chosen consumer and projects it back on GET', async () => {
  const { GET, POST } = await import('./+server');
  const res = await (POST as any)({ locals: admin, request: req({ consumerId: b, label: 'Living room TV' }) });
  const minted = await res.json();
  expect(minted.ok).toBe(true);
  // The admin cannot build the install URL without the token in the POST response.
  expect(minted.token).toMatch(/^[0-9a-f]{48}$/);
  expect(resolveAddonToken(db, minted.token)).toEqual({ token: minted.token, consumerId: b });

  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(true);
  expect(body.token).toBe(minted.token);
  expect(body.consumerId).toBe(b);
  expect(body.label).toBe('Living room TV');
  expect(body.createdAt).toEqual(expect.any(Number));
  expect(body.lastUsedAt).toBeNull();
});

it('projects lastUsedAt once the addon has actually been used', async () => {
  // Without this the panel shows "never used" forever and the admin cannot tell a live install
  // from a dead one. `lastUsedAt` is only ever non-null after the public route touches it.
  const { GET, POST } = await import('./+server');
  const { token } = await (await (POST as any)({ locals: admin, request: req({ consumerId: a }) })).json();
  touchAddonToken(db, token);
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.lastUsedAt).toEqual(expect.any(Number));
});

it('stores no label when none is given', async () => {
  const { GET, POST } = await import('./+server');
  await (POST as any)({ locals: admin, request: req({ consumerId: a }) });
  expect((await (await (GET as any)({ locals: admin })).json()).label).toBeNull();
  expect(readAddonToken(db)!.label).toBeNull();
});

it('refuses to mint for a consumerId that is not a real consumer', async () => {
  // A token pointing at a deleted or invented consumer resolves, streams, and then 404s on every
  // request action with nothing in the UI to explain it. Reject at the door instead.
  const { POST } = await import('./+server');
  for (const bad of [{ consumerId: 9999 }, { consumerId: 'a' }, { consumerId: null }, {}]) {
    await expect((POST as any)({ locals: admin, request: req(bad) }))
      .rejects.toMatchObject({ status: 400 });
  }
  expect(readAddonToken(db)).toBeNull();
});

it('minting again revokes the previous token immediately', async () => {
  // The panel promises "the old URL stops working immediately". If a second mint left the first
  // row live, `resolveAddonToken` would still accept the old token and that promise is a lie.
  const { POST } = await import('./+server');
  const first = (await (await (POST as any)({ locals: admin, request: req({ consumerId: a }) })).json()).token;
  const second = (await (await (POST as any)({ locals: admin, request: req({ consumerId: b }) })).json()).token;
  expect(second).not.toBe(first);
  expect(resolveAddonToken(db, first)).toBeNull();
  expect(resolveAddonToken(db, second)).toEqual({ token: second, consumerId: b });
  expect(readAddonToken(db)!.consumerId).toBe(b);
});

it('revokes on DELETE, leaving the old token dead and the panel unminted', async () => {
  const { GET, POST, DELETE } = await import('./+server');
  const { token } = await (await (POST as any)({ locals: admin, request: req({ consumerId: a }) })).json();
  expect(await (await (DELETE as any)({ locals: admin })).json()).toEqual({ ok: true });
  expect(resolveAddonToken(db, token)).toBeNull();
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(false);
  expect(body.token).toBeNull();
});
