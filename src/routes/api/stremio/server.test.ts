/**
 * Route-level tests for the household Stremio admin API.
 *
 * Load-bearing properties: the authKey never reaches the browser (`readHousehold` hands back the
 * DECRYPTED secret, so the handler must project explicit fields); the password is never persisted,
 * echoed, or logged; the password endpoint is actually rate-limited (`rateLimit` returns a result
 * rather than throwing, so an unchecked call is a silent no-op).
 * Hermetic in-memory DB; `fetch` stubbed per test.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import {
  readHousehold, saveStremioConnection, setParticipants,
  recordHouseholdSuccess, recordHouseholdFailure
} from '$lib/server/consumer/household-stremio';
import { MAX_FAILS } from '$lib/server/consumer/spoke-credentials';
import { __resetRequestLimitState } from '$lib/server/request-limit';

let db: DB;
let a: number;
let b: number;

vi.mock('$lib/server/db', async (orig) => {
  const real = await orig<typeof import('$lib/server/db')>();
  return { ...real, getDb: () => db };
});

beforeEach(() => {
  // `rateLimit` keeps a module-level sliding window that survives across tests in a file.
  // Without this reset the invalid-input POSTs (rateLimit runs BEFORE body validation) burn slots
  // and eventually tip a later test into a spurious 429. Same reset /api/stremio's POST needs.
  __resetRequestLimitState();
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const mk = (n: string) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,?,'active',?)"
  ).run(n, Date.now()).lastInsertRowid);
  a = mk('Jader'); b = mk('Jessica');
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

const admin = { user: { id: 1 } } as any;
const anon = { user: null } as any;
const req = (body: unknown) => new Request('http://x/api/stremio', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

it('rejects a caller with no admin session', async () => {
  const { GET, POST, PATCH, DELETE } = await import('./+server');
  for (const call of [
    () => (GET as any)({ locals: anon }),
    () => (POST as any)({ locals: anon, request: req({ email: 'e', password: 'p' }), getClientAddress: () => '1.1.1.1' }),
    () => (PATCH as any)({ locals: anon, request: req({ participantIds: [] }) }),
    () => (DELETE as any)({ locals: anon })
  ]) {
    await expect(call()).rejects.toMatchObject({ status: 401 });
  }
});

it('reports unlinked state with the consumer roster', async () => {
  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(false);
  expect(body.participantIds).toEqual([]);
  expect(body.consumers.map((c: any) => c.displayName).sort()).toEqual(['Jader', 'Jessica']);
});

it('never ships the authKey to the browser', async () => {
  // `readHousehold` returns the DECRYPTED authKey on `.connection.secret`. This endpoint must
  // project explicit fields and never spread the connection — returning `readHousehold(db)` whole
  // would hand the household credential to anything that can reach the admin page.
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-super-secret' });
  const { GET } = await import('./+server');
  const res = await (GET as any)({ locals: admin });
  const raw = await res.text();
  expect(raw).not.toContain('ak-super-secret');
  expect(raw).not.toContain('secret');
  expect(JSON.parse(raw).email).toBe('fixture-account@example.invalid');
});

it('projects the health fields a linked connection carries', async () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  setParticipants(db, [a, b]);
  recordHouseholdSuccess(db);
  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(true);
  expect(body.enabled).toBe(true);
  expect(body.email).toBe('fixture-account@example.invalid');
  expect(body.participantIds).toEqual([a, b]);
  expect(body.lastSyncAt).toEqual(expect.any(Number));
  expect(body.lastError).toBeNull();
});

it('projects a degraded connection so the panel can show why sync stopped', async () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  for (let i = 0; i < MAX_FAILS; i++) recordHouseholdFailure(db, 'Invalid auth');
  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: admin })).json();
  expect(body.linked).toBe(true);
  // These two drive the "Disabled — re-link" banner and the error line. Without them the admin
  // sees a healthy-looking panel while nothing is syncing.
  expect(body.enabled).toBe(false);
  expect(body.lastError).toBe('Invalid auth');
});

it('links with email + password, stores only the authKey, and never echoes the password', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    expect(String(url)).toContain('/login');
    return new Response(JSON.stringify({ result: { authKey: 'ak-live' } }), { status: 200 });
  }) as any);
  const { POST } = await import('./+server');
  const res = await (POST as any)({
    locals: admin, request: req({ email: 'fixture-account@example.invalid', password: 'fixture-not-a-password' }),
    getClientAddress: () => '1.1.1.1'
  });
  expect(await res.json()).toEqual({ ok: true });
  const h = readHousehold(db)!;
  expect(h.connection.secret).toBe('ak-live');
  // Falsifiable, unlike a check inside saveStremioConnection: the password IS in scope here, so
  // this fails if the handler ever persists it. Check the stored row too, not just the options.
  expect(JSON.stringify(h.connection.options)).not.toContain('fixture-not-a-password');
  const rawRow = db.prepare("SELECT * FROM connections WHERE type='stremio'").get() as any;
  expect(JSON.stringify(rawRow)).not.toContain('fixture-not-a-password');
});

it('maps a Stremio credential rejection to 400 and an outage to 502', async () => {
  const { POST } = await import('./+server');
  global.fetch = (vi.fn(async () =>
    new Response(JSON.stringify({ error: { code: 1, message: 'Invalid password' } }), { status: 200 })) as any);
  // Assert the BODY, not just the status: without this the handler could interpolate the password
  // into the message and every status assertion would still pass. SvelteKit's `error()` throws an
  // HttpError carrying `.body.message`.
  await expect((POST as any)({
    locals: admin, request: req({ email: 'fixture@example.invalid', password: 'fixture-secret-marker' }), getClientAddress: () => '1.1.1.1'
  })).rejects.toMatchObject({
    status: 400,
    body: { message: expect.not.stringContaining('fixture-secret-marker') }
  });

  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await expect((POST as any)({
    locals: admin, request: req({ email: 'fixture@example.invalid', password: 'fixture-outage-marker' }), getClientAddress: () => '1.1.1.1'
  })).rejects.toMatchObject({
    status: 502,
    body: { message: expect.not.stringContaining('fixture-outage-marker') }
  });
  expect(readHousehold(db)).toBeNull();
});

it('requires both email and password, without ever calling Stremio', async () => {
  // No stub here would mean a real POST to api.strem.io — which returns an error envelope and
  // makes this test pass for the wrong reason, over the network, on every run.
  const fetchSpy = vi.fn(async () =>
    new Response(JSON.stringify({ result: { authKey: 'ak' } }), { status: 200 }));
  global.fetch = fetchSpy as any;
  const { POST } = await import('./+server');
  for (const body of [{ email: '', password: 'p' }, { email: 'fixture@example.invalid', password: '' }]) {
    await expect((POST as any)({
      locals: admin, request: req(body), getClientAddress: () => '1.1.1.1'
    })).rejects.toMatchObject({ status: 400 });
  }
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('rate-limits the login endpoint', async () => {
  global.fetch = (vi.fn(async () =>
    new Response(JSON.stringify({ result: { authKey: 'ak' } }), { status: 200 })) as any);
  const { POST } = await import('./+server');
  const call = () => (POST as any)({
    locals: admin, request: req({ email: 'fixture@example.invalid', password: 'p' }), getClientAddress: () => '9.9.9.9'
  });
  for (let i = 0; i < 5; i++) await call();
  await expect(call()).rejects.toMatchObject({ status: 429 });
});

it('sets participants, dropping ids that are not real consumers', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  const { PATCH } = await import('./+server');
  const res = await (PATCH as any)({ locals: admin, request: req({ participantIds: [a, 9999, 'x'] }) });
  expect((await res.json()).participantIds).toEqual([a]);
  expect(readHousehold(db)!.participantIds).toEqual([a]);
  // The echo must match what `setParticipants` actually wrote — it dedupes, so the route must too.
  const dup = await (PATCH as any)({ locals: admin, request: req({ participantIds: [a, a] }) });
  expect((await dup.json()).participantIds).toEqual([a]);
});

it('accepts an empty participant list', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  setParticipants(db, [a, b]);
  const { PATCH } = await import('./+server');
  await (PATCH as any)({ locals: admin, request: req({ participantIds: [] }) });
  expect(readHousehold(db)!.participantIds).toEqual([]);
});

it('rejects a PATCH whose body is not a participantIds array', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  const { PATCH } = await import('./+server');
  await expect((PATCH as any)({ locals: admin, request: req({ participantIds: 'all' }) }))
    .rejects.toMatchObject({ status: 400 });
});

it('unlinks', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  const { DELETE } = await import('./+server');
  await (DELETE as any)({ locals: admin });
  expect(readHousehold(db)).toBeNull();
});

it('the test endpoint reports how many items the live Library returns', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  global.fetch = (vi.fn(async () => new Response(JSON.stringify({
    result: [
      { _id: 'tt1', name: 'A', type: 'movie', removed: false },
      { _id: 'tt2', name: 'B', type: 'movie', removed: true }
    ]
  }), { status: 200 })) as any);
  const { POST } = await import('./test/+server');
  const body = await (await (POST as any)({ locals: admin })).json();
  expect(body).toEqual({ ok: true, total: 2, active: 1 });
});

it('the test endpoint reports a failure rather than throwing', async () => {
  saveStremioConnection(db, { email: 'fixture@example.invalid', authKey: 'ak' });
  global.fetch = (vi.fn(async () => new Response('no', { status: 401 })) as any);
  const { POST } = await import('./test/+server');
  const body = await (await (POST as any)({ locals: admin })).json();
  expect(body.ok).toBe(false);
  expect(body.message).toContain('401');
});

it('the test endpoint rejects a caller with no admin session', async () => {
  // The 'rejects a caller with no admin session' case above only iterates ./+server's four
  // handlers, so deleting this endpoint's own guard would go unnoticed.
  const { POST } = await import('./test/+server');
  await expect((POST as any)({ locals: anon })).rejects.toMatchObject({ status: 401 });
});

it('the test endpoint 400s when nothing is linked', async () => {
  const { POST } = await import('./test/+server');
  await expect((POST as any)({ locals: admin })).rejects.toMatchObject({ status: 400 });
});
