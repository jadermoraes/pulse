# Stremio Watchlist Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A consumer's pulse watchlist and in-flight requests appear in their Stremio Library, and titles they save in Stremio come back to pulse.

**Architecture:** Stremio is a spoke on the existing hub. Pulse pushes to Stremio's cloud datastore (`api.strem.io`) — no addon, no inbound hosting. A pure `reconcile()` function decides push/remove/import/delete from two lists; a thin orchestrator applies its output. Shipped in two stages: push first (Tasks 1-5), then pull (Task 6).

**Tech Stack:** SvelteKit 2 / Svelte 5, TypeScript, better-sqlite3, zod 4, vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-stremio-library-sync-design.md` (API details, linking flow, reconciler contract) and `docs/superpowers/specs/2026-08-28-sync-hub-design.md` (hub/spoke topology, `spoke_credentials` / `sync_state`).

## Global Constraints

- Test command: `npm test` (vitest). Tests open an in-memory DB via `openDb(':memory:')` then `migrate(db)`. **Never** point a test at the real `pulse.sqlite`.
- `foreign_keys = ON`. Seed `roles` then `consumer_users` before rows that reference them. **`migrate()` auto-seeds an Admin role at id=1 — use id=2 for a test role.** `roles` has NO `capabilities` column; its columns are `id, name, allow_list, monthly_token_cap, auto_approve, seerr_quota, is_admin, editable, created_at`.
- Schema goes in the single `migrate()` block in `src/lib/server/db.ts`, `CREATE TABLE IF NOT EXISTS`, idempotent — it re-runs on every boot against a live database. **No `ALTER`** — `migrate()` is uncaught in `getDb()`, so a throwing statement stops the app booting.
- Every external response is validated with `zod` before use; a validation failure aborts rather than falling through to a partial write.
- Secrets encrypted at rest via `src/lib/server/crypto.ts`. The Stremio **password is used once and never persisted**, never logged. No token, key, or password appears in any log or error message.
- New consumer routes are consumer-session-gated and **must NOT** be added to `CONSUMER_PUBLIC` in `src/hooks.server.ts`.
- User-visible copy goes in **both** `src/lib/i18n/en.json` and `src/lib/i18n/pt-BR.json`, same key set. pt-BR stays direct and plain — no translated corporate idiom.
- Commit after every task. Personal repo: **no `Co-Authored-By`, no `Claude-Session`, no "Generated with Claude Code", no assistant attribution of any kind.**
- Baseline before Task 1: **1120 tests passing across 138 files**. Nothing may regress. `npm run check` must stay at 0 errors.

## Verified API facts — use these, they were probed against the live services

**Stremio login** — `POST https://api.strem.io/api/login`, body `{ email, password, type: "Login" }`.
A bad user returns `{"error":{"code":2,"message":"User not found","wrongEmail":true}}`; a success
returns a result carrying the `authKey`. **Errors arrive inside a 200 response body**, so a
non-`res.ok` check alone is not enough — always inspect `error`.

**Stremio datastore** — `POST https://api.strem.io/api/datastoreGet` and `.../datastorePut`, body
`{ authKey, collection: "libraryItem", ... }`. Library items are keyed by **IMDb `tt` ids** and
carry `_id`, `name`, `type` (`"movie"` | `"series"`), `poster`, `_ctime`, `_mtime`, `state`
(watch progress), and the flags `removed`, `temp`. **Removal is `removed: true`, not deletion.**

**Cinemeta** (Stremio's own metadata addon, free, unauthenticated) —
`GET https://v3-cinemeta.strem.io/meta/{movie|series}/{ttId}.json` returns
`{ meta: { id, imdb_id, moviedb_id, name, poster, year, type, ... } }`. Probed:
`tt0111161` → `moviedb_id: 278`, `name: "The Shawshank Redemption"`. This is both the reverse
imdb→tmdb lookup AND the source of `name`/`poster` when pulse creates a library item.

Forward tmdb→imdb comes from Seerr, already read at `src/lib/server/integrations/seerr.ts:265`.

## Known unknown, and how it is handled

The exact minimal payload Stremio accepts for a **newly created** `libraryItem` is not documented
and could not be probed without a real account. **Task 5 must not guess it blind.** The orchestrator
reads the viewer's existing library first (`datastoreGet`), and when creating a new item it copies
the field shape of an existing one — same keys, same `state` skeleton with progress zeroed — rather
than inventing a structure. If the library is empty, it writes the documented field set above. The
manual smoke step at the end confirms an item actually appears in the Stremio UI before this is
trusted.

---

### Task 1: IMDb ↔ TMDB cache table + Cinemeta client

**Files:**
- Modify: `src/lib/server/db.ts` (append inside the existing `migrate()` block)
- Create: `src/lib/server/integrations/cinemeta.ts`
- Test: `src/lib/server/integrations/cinemeta.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface CinemetaMeta { imdbId: string; tmdbId: number | null; name: string; poster: string | null; type: 'movie' | 'series' }`
  - `fetchCinemetaMeta(imdbId: string, type: 'movie' | 'series'): Promise<CinemetaMeta | null>` — `null` when Cinemeta has no such id
  - `resolveImdbMeta(db: DB, imdbId: string, type: 'movie' | 'series'): Promise<CinemetaMeta | null>` — cached wrapper

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/integrations/cinemeta.test.ts`:

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { fetchCinemetaMeta, resolveImdbMeta } from './cinemeta';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockJson(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = spy as any;
  return spy;
}

it('maps a cinemeta movie payload', async () => {
  const spy = mockJson(200, { meta: {
    id: 'tt0111161', imdb_id: 'tt0111161', moviedb_id: 278,
    name: 'The Shawshank Redemption', poster: 'https://img/p.jpg', type: 'movie'
  } });
  const m = await fetchCinemetaMeta('tt0111161', 'movie');
  expect(m).toEqual({
    imdbId: 'tt0111161', tmdbId: 278, name: 'The Shawshank Redemption',
    poster: 'https://img/p.jpg', type: 'movie'
  });
  expect((spy.mock.calls[0] as any)[0]).toBe('https://v3-cinemeta.strem.io/meta/movie/tt0111161.json');
});

it('uses the series path for a show', async () => {
  const spy = mockJson(200, { meta: { id: 'tt0903747', imdb_id: 'tt0903747', moviedb_id: 1396, name: 'Breaking Bad', type: 'series' } });
  const m = await fetchCinemetaMeta('tt0903747', 'series');
  expect(m?.tmdbId).toBe(1396);
  expect(m?.poster).toBeNull();
  expect((spy.mock.calls[0] as any)[0]).toBe('https://v3-cinemeta.strem.io/meta/series/tt0903747.json');
});

it('returns null on 404 rather than throwing', async () => {
  mockJson(404, {});
  expect(await fetchCinemetaMeta('tt0000000', 'movie')).toBeNull();
});

it('rejects a malformed payload instead of returning a partial meta', async () => {
  mockJson(200, { meta: { id: 'tt1' } }); // no name, no type
  await expect(fetchCinemetaMeta('tt1', 'movie')).rejects.toThrow();
});

it('resolveImdbMeta caches: a second call makes no fetch', async () => {
  const spy = mockJson(200, { meta: {
    id: 'tt0111161', imdb_id: 'tt0111161', moviedb_id: 278, name: 'Shawshank', poster: null, type: 'movie'
  } });
  expect((await resolveImdbMeta(db, 'tt0111161', 'movie'))?.tmdbId).toBe(278);
  expect((await resolveImdbMeta(db, 'tt0111161', 'movie'))?.tmdbId).toBe(278);
  expect(spy).toHaveBeenCalledTimes(1);
});

it('resolveImdbMeta caches a negative answer too', async () => {
  const spy = mockJson(404, {});
  expect(await resolveImdbMeta(db, 'tt0000000', 'movie')).toBeNull();
  expect(await resolveImdbMeta(db, 'tt0000000', 'movie')).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/integrations/cinemeta.test.ts`
Expected: FAIL — cannot resolve `./cinemeta`.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/server/db.ts`, append inside the existing `db.exec(\`...\`)` block:

```sql
CREATE TABLE IF NOT EXISTS imdb_meta_cache (
  imdb_id    TEXT NOT NULL,
  media_type TEXT NOT NULL,
  tmdb_id    INTEGER,
  name       TEXT,
  poster     TEXT,
  found      INTEGER NOT NULL,
  cached_at  INTEGER NOT NULL,
  PRIMARY KEY (imdb_id, media_type)
);
CREATE INDEX IF NOT EXISTS idx_imdb_meta_tmdb ON imdb_meta_cache(tmdb_id, media_type);
```

The index backs the reverse lookup Task 5 does (`WHERE tmdb_id=? AND media_type=?`).

`found = 0` is the negative cache — Cinemeta genuinely has no such id, so do not re-ask.

Create `src/lib/server/integrations/cinemeta.ts`:

```ts
import { z } from 'zod';
import type { DB } from '../db';

// Cinemeta is Stremio's own metadata addon: free, unauthenticated, and the same catalogue
// Stremio itself resolves against — which makes it the right source for both the reverse
// imdb -> tmdb lookup and the name/poster used when pulse creates a library item.
const BASE = 'https://v3-cinemeta.strem.io';

export interface CinemetaMeta {
  imdbId: string;
  tmdbId: number | null;
  name: string;
  poster: string | null;
  type: 'movie' | 'series';
}

const MetaResponse = z.object({
  meta: z.object({
    imdb_id: z.string().nullish(),
    id: z.string(),
    moviedb_id: z.number().nullish(),
    name: z.string(),
    poster: z.string().nullish(),
    type: z.enum(['movie', 'series'])
  })
});

export async function fetchCinemetaMeta(
  imdbId: string, type: 'movie' | 'series'
): Promise<CinemetaMeta | null> {
  const res = await fetch(`${BASE}/meta/${type}/${imdbId}.json`, { headers: { Accept: 'application/json' } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cinemeta HTTP ${res.status}`);
  const d = MetaResponse.parse(await res.json()).meta;
  return {
    imdbId: d.imdb_id ?? d.id,
    tmdbId: d.moviedb_id ?? null,
    name: d.name,
    poster: d.poster ?? null,
    type: d.type
  };
}

/** Cached wrapper. Cinemeta's answer for an imdb id never changes, so the cache never expires. */
export async function resolveImdbMeta(
  db: DB, imdbId: string, type: 'movie' | 'series'
): Promise<CinemetaMeta | null> {
  const row = db.prepare('SELECT * FROM imdb_meta_cache WHERE imdb_id=? AND media_type=?')
    .get(imdbId, type) as any;
  if (row) {
    if (!row.found) return null;
    return { imdbId, tmdbId: row.tmdb_id ?? null, name: row.name, poster: row.poster ?? null, type };
  }

  const meta = await fetchCinemetaMeta(imdbId, type);
  db.prepare(
    `INSERT OR REPLACE INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(imdbId, type, meta?.tmdbId ?? null, meta?.name ?? null, meta?.poster ?? null, meta ? 1 : 0, Date.now());
  return meta;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/integrations/cinemeta.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/db.ts src/lib/server/integrations/cinemeta.ts src/lib/server/integrations/cinemeta.test.ts
git commit -m "feat(cinemeta): imdb->tmdb resolution with a permanent cache"
```

---

### Task 2: Stremio API client

**Files:**
- Create: `src/lib/server/integrations/stremio.ts`
- Test: `src/lib/server/integrations/stremio.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class StremioError extends Error { code: number | null }` (exported)
  - `interface StremioLibraryItem { _id: string; name: string; type: string; poster: string | null; removed: boolean; temp: boolean; _ctime: string; _mtime: string; state: Record<string, unknown>; [k: string]: unknown }`
  - `stremioLogin(email: string, password: string): Promise<string>` — returns the `authKey`
  - `datastoreGet(authKey: string): Promise<StremioLibraryItem[]>`
  - `datastorePut(authKey: string, changes: StremioLibraryItem[]): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/integrations/stremio.test.ts`:

```ts
import { it, expect, afterEach, vi } from 'vitest';
import { stremioLogin, datastoreGet, datastorePut, StremioError } from './stremio';

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockJson(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  global.fetch = spy as any;
  return spy;
}

const ITEM = {
  _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'p.jpg',
  removed: false, temp: false, _ctime: '2026-01-01T00:00:00.000Z',
  _mtime: '2026-01-01T00:00:00.000Z', state: { timeOffset: 0 }
};

it('login returns the authKey and posts the documented body', async () => {
  const spy = mockJson(200, { result: { authKey: 'ak-123' } });
  expect(await stremioLogin('a@b.c', 'pw')).toBe('ak-123');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/login');
  expect(JSON.parse(init.body)).toEqual({ email: 'a@b.c', password: 'pw', type: 'Login' });
});

it('login surfaces an error carried INSIDE a 200 body', async () => {
  mockJson(200, { error: { code: 2, message: 'User not found', wrongEmail: true } });
  await expect(stremioLogin('a@b.c', 'pw')).rejects.toBeInstanceOf(StremioError);
});

it('login never puts the password in the thrown message', async () => {
  mockJson(200, { error: { code: 2, message: 'User not found' } });
  await expect(stremioLogin('a@b.c', 'hunter2')).rejects.toThrow(/^(?!.*hunter2).*$/s);
});

it('datastoreGet returns the library array', async () => {
  const spy = mockJson(200, { result: [ITEM] });
  const items = await datastoreGet('ak');
  expect(items).toHaveLength(1);
  expect(items[0]._id).toBe('tt0111161');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/datastoreGet');
  expect(JSON.parse(init.body)).toMatchObject({ authKey: 'ak', collection: 'libraryItem' });
});

it('datastoreGet rejects a malformed item rather than returning a partial library', async () => {
  mockJson(200, { result: [{ _id: 'tt1' }] }); // missing name/type/state
  await expect(datastoreGet('ak')).rejects.toThrow();
});

it('datastoreGet surfaces an in-body error', async () => {
  mockJson(200, { error: { code: 1, message: 'Invalid auth' } });
  await expect(datastoreGet('ak')).rejects.toBeInstanceOf(StremioError);
});

it('datastorePut posts the changes under the documented envelope', async () => {
  const spy = mockJson(200, { result: {} });
  await datastorePut('ak', [ITEM]);
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.strem.io/api/datastorePut');
  expect(JSON.parse(init.body)).toEqual({ authKey: 'ak', collection: 'libraryItem', changes: [ITEM] });
});

it('datastorePut does nothing when there are no changes', async () => {
  const spy = mockJson(200, {});
  await datastorePut('ak', []);
  expect(spy).not.toHaveBeenCalled();
});

it('an authKey never appears in a thrown message', async () => {
  mockJson(500, {});
  await expect(datastoreGet('secret-key')).rejects.toThrow(/^(?!.*secret-key).*$/s);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/integrations/stremio.test.ts`
Expected: FAIL — cannot resolve `./stremio`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/integrations/stremio.ts`:

```ts
import { z } from 'zod';

// Unofficial. Stremio's Library is cloud datastore state, NOT addon-served: an addon can only
// produce a Discover row, so writing to the Library tab means these endpoints. No published
// contract, so every response is validated and a shape we do not recognise fails closed.
const API = 'https://api.strem.io/api';

export class StremioError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = 'StremioError';
    this.code = code;
  }
}

export interface StremioLibraryItem {
  _id: string;
  name: string;
  type: string;
  poster: string | null;
  removed: boolean;
  temp: boolean;
  _ctime: string;
  _mtime: string;
  state: Record<string, unknown>;
  [k: string]: unknown;
}

const ErrorEnvelope = z.object({
  error: z.object({ code: z.number().nullish(), message: z.string().nullish() })
});

/** Stremio returns errors INSIDE a 200 body, so `res.ok` alone is not a success check. */
function throwIfErrorBody(body: unknown): void {
  const parsed = ErrorEnvelope.safeParse(body);
  if (parsed.success) {
    throw new StremioError(parsed.data.error.message ?? 'Stremio error', parsed.data.error.code ?? null);
  }
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body)
  });
  // Never interpolate the request body into an error — it carries the authKey or the password.
  if (!res.ok) throw new StremioError(`Stremio HTTP ${res.status}`, null);
  const json = await res.json();
  throwIfErrorBody(json);
  return json;
}

const LoginResult = z.object({ result: z.object({ authKey: z.string() }) });

export async function stremioLogin(email: string, password: string): Promise<string> {
  const json = await post('/login', { email, password, type: 'Login' });
  return LoginResult.parse(json).result.authKey;
}

const LibraryItem = z.object({
  _id: z.string(),
  name: z.string(),
  type: z.string(),
  poster: z.string().nullish(),
  removed: z.boolean().nullish(),
  temp: z.boolean().nullish(),
  _ctime: z.string().nullish(),
  _mtime: z.string().nullish(),
  state: z.record(z.string(), z.unknown()).nullish()
}).passthrough();

const GetResult = z.object({ result: z.array(LibraryItem) });

export async function datastoreGet(authKey: string): Promise<StremioLibraryItem[]> {
  const json = await post('/datastoreGet', { authKey, collection: 'libraryItem', all: true });
  return GetResult.parse(json).result.map((r) => ({
    ...r,
    poster: r.poster ?? null,
    removed: !!r.removed,
    temp: !!r.temp,
    _ctime: r._ctime ?? new Date(0).toISOString(),
    _mtime: r._mtime ?? new Date(0).toISOString(),
    state: r.state ?? {}
  })) as StremioLibraryItem[];
}

export async function datastorePut(authKey: string, changes: StremioLibraryItem[]): Promise<void> {
  if (changes.length === 0) return;
  await post('/datastorePut', { authKey, collection: 'libraryItem', changes });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/integrations/stremio.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/integrations/stremio.ts src/lib/server/integrations/stremio.test.ts
git commit -m "feat(stremio): datastore client (login, get, put) with fail-closed validation"
```

---

### Task 3: Link / unlink endpoint

**Files:**
- Create: `src/routes/api/app/stremio/+server.ts`
- Create: `src/routes/api/app/stremio/server.test.ts`
- Modify: `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json`

**Interfaces:**
- Consumes: `stremioLogin` (Task 2); `saveCredential`, `getCredential`, `deleteCredential` from `src/lib/server/consumer/spoke-credentials.ts` (`SpokeId` already includes `'stremio'`); `rateLimit` from `src/lib/server/request-limit.ts`; the capability helper in `src/lib/server/identity/capabilities.ts`.

These signatures are **verified against the codebase** — use them as written:
- `effectiveAllowList(user, role): Capability[]` from `src/lib/server/identity/consumers.ts:78` (a per-user `allowOverride` wins, else `role.allowList`), combined with `getConsumer` and `getRole` — this is exactly how `src/routes/api/app/me/+server.ts:20` resolves capabilities. There is **no** `hasCapability` helper; do not invent one.
- `rateLimit(key, max, windowMs, now?)` from `src/lib/server/request-limit.ts:6` **returns `{ ok, retryAfter }` and does not throw** — you must check `.ok`.

Add two tests: a consumer lacking the `watchlist` capability gets 403, and a sixth link attempt inside the window gets 429. Import `__resetRequestLimitState` from `request-limit.ts` in `beforeEach` so the in-memory window does not leak between tests.
- Produces: `GET /api/app/stremio` (status), `POST /api/app/stremio` (`{ email, password }` → link), `DELETE /api/app/stremio` (unlink).

- [ ] **Step 1: Write the failing test**

Create `src/routes/api/app/stremio/server.test.ts`:

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { getCredential, saveCredential } from '$lib/server/consumer/spoke-credentials';

let db: DB;
let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes/api/app/stremio/server.test.ts`
Expected: FAIL — cannot resolve `./+server`.

- [ ] **Step 3: Write minimal implementation**

Create `src/routes/api/app/stremio/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { stremioLogin, StremioError } from '$lib/server/integrations/stremio';
import { saveCredential, getCredential, deleteCredential } from '$lib/server/consumer/spoke-credentials';
import { logAccess } from '$lib/server/identity/access-log';
import { rateLimit } from '$lib/server/request-limit';
import { getConsumer, effectiveAllowList } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const c = getCredential(getDb(), locals.consumer.id, 'stremio');
  return json({
    linked: !!c,
    enabled: c?.enabled ?? false,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null
  });
};

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  // Spec: gated on the EXISTING `watchlist` capability — Stremio sync is a watchlist feature,
  // so it does not widen the Capability union or the roles UI. This is the same resolution
  // `/api/app/me` uses: a per-user override wins, else the role's allow-list.
  const db = getDb();
  const c = getConsumer(db, locals.consumer.id);
  if (!c) throw error(401, 'Unauthorized');
  const role = getRole(db, c.roleId)!;
  if (!effectiveAllowList(c, role).includes('watchlist')) throw error(403, 'Forbidden');

  // A login endpoint that takes a password must not be free to hammer. `rateLimit` RETURNS a
  // result, it does not throw.
  const limit = rateLimit(`stremio-link:${locals.consumer.id}`, 5, 60_000);
  if (!limit.ok) throw error(429, `Too many attempts. Try again in ${limit.retryAfter}s.`);
  const body = await request.json().catch(() => ({}));
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!email || !password) throw error(400, 'Email and password are required');

  let authKey: string;
  try {
    // The password is used for exactly this call and is never stored, logged, or echoed.
    authKey = await stremioLogin(email, password);
  } catch (e) {
    if (e instanceof StremioError) throw error(400, 'Stremio rejected those credentials');
    throw error(502, 'Could not reach Stremio');
  }

  saveCredential(getDb(), { consumerId: locals.consumer.id, spoke: 'stremio', secret: authKey });
  logAccess(getDb(), { consumerId: locals.consumer.id, type: 'stremio_link' });
  return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  deleteCredential(getDb(), locals.consumer.id, 'stremio');
  logAccess(getDb(), { consumerId: locals.consumer.id, type: 'stremio_unlink' });
  return json({ ok: true });
};
```

Add to `src/lib/i18n/en.json`:

```json
"stremio": {
  "title": "Stremio",
  "description": "Your watchlist shows up in Stremio's Library, on this computer and on the TV.",
  "email": "Stremio email",
  "password": "Stremio password",
  "connect": "Connect Stremio",
  "disconnect": "Disconnect",
  "linked": "Connected",
  "badCredentials": "Stremio didn't accept that email and password.",
  "unreachable": "Couldn't reach Stremio. Try again in a moment.",
  "passwordNote": "Your password is used once to sign in and is never stored."
}
```

Add to `src/lib/i18n/pt-BR.json`:

```json
"stremio": {
  "title": "Stremio",
  "description": "Sua lista aparece na Biblioteca do Stremio, neste computador e na TV.",
  "email": "E-mail do Stremio",
  "password": "Senha do Stremio",
  "connect": "Conectar Stremio",
  "disconnect": "Desconectar",
  "linked": "Conectado",
  "badCredentials": "O Stremio não aceitou esse e-mail e senha.",
  "unreachable": "Não deu para falar com o Stremio. Tente de novo em instantes.",
  "passwordNote": "Sua senha é usada uma vez para entrar e não fica guardada."
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes/api/app/stremio/server.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/app/stremio src/lib/i18n/en.json src/lib/i18n/pt-BR.json
git commit -m "feat(stremio): consumer link/unlink endpoint"
```

---

### Task 4: The reconciler (pure function)

**Files:**
- Create: `src/lib/server/consumer/stremio-reconcile.ts`
- Test: `src/lib/server/consumer/stremio-reconcile.test.ts`

**Interfaces:**
- Consumes: nothing — this task is deliberately free of DB and network.
- Produces:
  - `interface PulseItem { tmdbId: number; mediaType: 'movie' | 'tv'; imdbId: string | null; title: string; onServer: boolean; droppedAt: number | null }`
  - `interface StremioItem { imdbId: string; type: string; removed: boolean }`
  - `interface ReconcileResult { push: PulseItem[]; remove: PulseItem[]; importItems: StremioItem[]; deleteItems: PulseItem[]; clearDropped: PulseItem[] }`
  - `reconcile(pulseItems: PulseItem[], stremioItems: StremioItem[]): ReconcileResult`

**This is the task that matters most.** The removal guard lives here, and it is where the feature can silently destroy a viewer's watchlist. It is a pure function precisely so the truth table can be proved by test rather than observed in production.

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/consumer/stremio-reconcile.test.ts`:

```ts
import { it, expect } from 'vitest';
import { reconcile, type PulseItem, type StremioItem } from './stremio-reconcile';

const want = (over: Partial<PulseItem> = {}): PulseItem => ({
  tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161', title: 'Shawshank',
  onServer: false, droppedAt: null, ...over
});
const inStremio = (over: Partial<StremioItem> = {}): StremioItem =>
  ({ imdbId: 'tt0111161', type: 'movie', removed: false, ...over });

it('pushes a wanted title Stremio does not have', () => {
  const r = reconcile([want()], []);
  expect(r.push.map((p) => p.tmdbId)).toEqual([278]);
  expect(r.remove).toEqual([]);
});

it('does not re-push a title already present in Stremio', () => {
  expect(reconcile([want()], [inStremio()]).push).toEqual([]);
});

it('never pushes a row with no imdb id', () => {
  expect(reconcile([want({ imdbId: null })], []).push).toEqual([]);
});

it('removes an available title that is still in Stremio', () => {
  const r = reconcile([want({ onServer: true })], [inStremio()]);
  expect(r.remove.map((p) => p.tmdbId)).toEqual([278]);
});

it('does not remove an available title already gone from Stremio', () => {
  const r = reconcile([want({ onServer: true, droppedAt: 111 })], [inStremio({ removed: true })]);
  expect(r.remove).toEqual([]);
});

it('imports a title present in Stremio that pulse does not know', () => {
  const r = reconcile([], [inStremio({ imdbId: 'tt99' })]);
  expect(r.importItems.map((s) => s.imdbId)).toEqual(['tt99']);
});

it('does not import a removed stremio item', () => {
  expect(reconcile([], [inStremio({ imdbId: 'tt99', removed: true })]).importItems).toEqual([]);
});

it('deletes a pulse row the viewer removed in Stremio', () => {
  const r = reconcile([want()], [inStremio({ removed: true })]);
  expect(r.deleteItems.map((p) => p.tmdbId)).toEqual([278]);
});

it('IGNORES a removal pulse itself performed', () => {
  const r = reconcile([want({ onServer: true, droppedAt: 999 })], [inStremio({ removed: true })]);
  expect(r.deleteItems).toEqual([]);
});

it('clears the dropped stamp when the viewer re-adds the title', () => {
  const r = reconcile([want({ droppedAt: 999 })], [inStremio({ removed: false })]);
  expect(r.clearDropped.map((p) => p.tmdbId)).toEqual([278]);
  expect(r.deleteItems).toEqual([]);
});

it('the drop -> re-add -> drop cycle terminates', () => {
  // 1. available, still in stremio -> remove + stamp
  expect(reconcile([want({ onServer: true })], [inStremio()]).remove).toHaveLength(1);
  // 2. viewer re-adds it -> stamp cleared, NOT deleted
  const second = reconcile([want({ onServer: true, droppedAt: 5 })], [inStremio({ removed: false })]);
  expect(second.clearDropped).toHaveLength(1);
  expect(second.deleteItems).toEqual([]);
  // 3. with the stamp cleared it is removed once more, and stops there
  const third = reconcile([want({ onServer: true, droppedAt: null })], [inStremio({ removed: false })]);
  expect(third.remove).toHaveLength(1);
  expect(third.importItems).toEqual([]);
});

it('matches series type to pulse tv rows', () => {
  const r = reconcile([want({ mediaType: 'tv', imdbId: 'tt0903747' })], [{ imdbId: 'tt0903747', type: 'series', removed: false }]);
  expect(r.push).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/stremio-reconcile.test.ts`
Expected: FAIL — cannot resolve `./stremio-reconcile`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/consumer/stremio-reconcile.ts`:

```ts
export interface PulseItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  imdbId: string | null;
  title: string;
  onServer: boolean;
  /** Set ONLY when pulse itself removed the item from Stremio. Never set by a viewer action. */
  droppedAt: number | null;
}

export interface StremioItem {
  imdbId: string;
  type: string;
  removed: boolean;
}

export interface ReconcileResult {
  push: PulseItem[];
  remove: PulseItem[];
  importItems: StremioItem[];
  deleteItems: PulseItem[];
  clearDropped: PulseItem[];
}

export function stremioType(mediaType: 'movie' | 'tv'): 'movie' | 'series' {
  return mediaType === 'tv' ? 'series' : 'movie';
}

/**
 * Pure. No DB, no network, no clock.
 *
 * The guard that matters: pulse stamps `droppedAt` when IT removes an item (because the title
 * became available on the server). The pull direction must never read that disappearance as
 * "the viewer deleted this" — otherwise the two directions fight and silently eat watchlist
 * rows. Seeing the item present again clears the stamp and re-arms removal detection.
 */
export function reconcile(pulseItems: PulseItem[], stremioItems: StremioItem[]): ReconcileResult {
  const byImdb = new Map<string, StremioItem>();
  for (const s of stremioItems) byImdb.set(s.imdbId, s);

  const knownImdb = new Set(pulseItems.map((p) => p.imdbId).filter((v): v is string => !!v));

  const push: PulseItem[] = [];
  const remove: PulseItem[] = [];
  const deleteItems: PulseItem[] = [];
  const clearDropped: PulseItem[] = [];

  for (const p of pulseItems) {
    if (!p.imdbId) continue; // unresolvable: never syncs, not an error
    const s = byImdb.get(p.imdbId);
    const presentInStremio = !!s && !s.removed;

    if (p.droppedAt !== null && presentInStremio) { clearDropped.push(p); continue; }

    if (p.onServer) {
      if (presentInStremio) remove.push(p);
      continue;
    }

    if (!s) { push.push(p); continue; }

    if (s.removed) {
      // Absent because pulse dropped it -> ignore. Absent because the viewer removed it -> delete.
      if (p.droppedAt === null) deleteItems.push(p);
    }
  }

  const importItems = stremioItems.filter((s) => !s.removed && !knownImdb.has(s.imdbId));

  return { push, remove, importItems, deleteItems, clearDropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/consumer/stremio-reconcile.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/stremio-reconcile.ts src/lib/server/consumer/stremio-reconcile.test.ts
git commit -m "feat(stremio): pure reconciler with the pulse-origin removal guard"
```

---

### Task 5: Push stage — orchestrator + poller wiring

**Files:**
- Create: `src/lib/server/consumer/stremio-sync.ts`
- Test: `src/lib/server/consumer/stremio-sync.test.ts`
- Modify: `src/lib/server/agent/events.ts`

**Interfaces:**
- Consumes: `reconcile`, `PulseItem`, `StremioItem`, `stremioType` (Task 4); `datastoreGet`, `datastorePut`, `StremioLibraryItem`, `StremioError` (Task 2); `resolveImdbMeta` (Task 1); `listEnabled`, `recordSuccess`, `recordFailure`, `recordNote` from `spoke-credentials.ts`; `listWatchlist` from `watchlist.ts`; `getJsonWithKey`, `joinUrl` from `../http`; `listConnections` from `../connections`.
- Produces:
  - `loadPulseItems(db: DB, consumerId: number, seerr: Connection | null): Promise<PulseItem[]>` — the UNION of watchlist rows and not-yet-available `consumer_requests`, deduped on `(tmdbId, mediaType)`
  - `buildLibraryItem(p: PulseItem, template: StremioLibraryItem | null, meta: { name: string; poster: string | null } | null): StremioLibraryItem`
  - `pollStremioSync(db: DB): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/consumer/stremio-sync.test.ts`:

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { buildLibraryItem, pollStremioSync } from './stremio-sync';
import { saveCredential, getCredential } from './spoke-credentials';
import { addWatchlist } from './watchlist';
import type { PulseItem } from './stremio-reconcile';

const want: PulseItem = {
  tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161',
  title: 'Shawshank', onServer: false, droppedAt: null
};

let db: DB;
let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const info = db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Jader','active',?)"
  ).run(Date.now());
  consumerId = Number(info.lastInsertRowid);
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('buildLibraryItem copies the shape of an existing item rather than inventing one', () => {
  const template = {
    _id: 'tt999', name: 'Other', type: 'movie', poster: 'x.jpg', removed: false, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-01-01T00:00:00.000Z',
    state: { timeOffset: 42, watched: 'yes' }, someUnknownField: 7
  } as any;
  const item = buildLibraryItem(want, template, { name: 'Shawshank', poster: 'p.jpg' });
  expect(item._id).toBe('tt0111161');
  expect(item.type).toBe('movie');
  expect(item.removed).toBe(false);
  // template's own keys survive, but its progress is NOT inherited
  expect(Object.keys(item)).toContain('someUnknownField');
  expect((item.state as any).timeOffset).toBe(0);
});

it('buildLibraryItem maps a tv row to the series type', () => {
  const item = buildLibraryItem({ ...want, mediaType: 'tv', imdbId: 'tt0903747' }, null, null);
  expect(item.type).toBe('series');
  expect(item._id).toBe('tt0903747');
});

it('pushes a wanted title into an empty stremio library', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt0111161','movie',278,'Shawshank',NULL,1,?)`
  ).run(Date.now());
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    calls.push(String(url));
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);

  expect(calls.some((u) => u.endsWith('/datastorePut'))).toBe(true);
  expect(getCredential(db, consumerId, 'stremio')?.lastSyncAt).not.toBeNull();
});

it('pushes an in-flight request that is not on the watchlist', async () => {
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','pending',?)`
  ).run(consumerId, Date.now());
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt0111161','movie',278,'Shawshank',NULL,1,?)`
  ).run(Date.now());

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);
  expect(putBody.changes.map((c: any) => c._id)).toEqual(['tt0111161']);
});

it('a failing spoke records the failure and never throws', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: true });
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });

  await expect(pollStremioSync(db)).resolves.toBeUndefined();
  expect(getCredential(db, consumerId, 'stremio')?.lastError).toBeTruthy();
});

it('a consumer with an empty watchlist and an empty library makes no put', async () => {
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  }) as any);
  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);
  expect(calls.some((u) => u.endsWith('/datastorePut'))).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/stremio-sync.test.ts`
Expected: FAIL — cannot resolve `./stremio-sync`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/consumer/stremio-sync.ts`:

```ts
import type { DB } from '../db';
import type { Connection } from '../connections';
import { listConnections } from '../connections';
import { getJsonWithKey, joinUrl } from '../http';
import { datastoreGet, datastorePut, type StremioLibraryItem } from '../integrations/stremio';
import { resolveImdbMeta } from '../integrations/cinemeta';
import { listWatchlist } from './watchlist';
import { listEnabled, recordSuccess, recordFailure, recordNote } from './spoke-credentials';
import { reconcile, stremioType, type PulseItem, type StremioItem } from './stremio-reconcile';

/** Forward tmdb -> imdb via Seerr, cached in imdb_meta_cache's row for the same pair. */
async function imdbForTmdb(
  db: DB, seerr: Connection | null, tmdbId: number, mediaType: 'movie' | 'tv'
): Promise<string | null> {
  const cached = db.prepare('SELECT imdb_id FROM imdb_meta_cache WHERE tmdb_id=? AND media_type=?')
    .get(tmdbId, mediaType === 'tv' ? 'series' : 'movie') as any;
  if (cached?.imdb_id) return cached.imdb_id;
  if (!seerr) return null;
  try {
    const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
    const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
    const imdb: string | null = d?.externalIds?.imdbId ?? d?.imdbId ?? null;
    if (imdb) {
      db.prepare(
        `INSERT OR REPLACE INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
         VALUES (?,?,?,NULL,NULL,1,?)`
      ).run(imdb, mediaType === 'tv' ? 'series' : 'movie', tmdbId, Date.now());
    }
    return imdb;
  } catch {
    return null;
  }
}

/**
 * Spec: the Library shows "wanted + in-flight, drop when available". So the push set is the
 * UNION of watchlist rows and the viewer's requests that have not landed yet, deduplicated on
 * (tmdbId, mediaType) with the watchlist row winning (it carries on_server).
 */
function inFlightRequests(db: DB, consumerId: number): Array<{ tmdbId: number; mediaType: string; title: string }> {
  return db.prepare(
    `SELECT tmdb_id AS tmdbId, media_type AS mediaType, title
       FROM consumer_requests
      WHERE consumer_id=? AND status <> 'available'`
  ).all(consumerId) as any[];
}

export async function loadPulseItems(
  db: DB, consumerId: number, seerr: Connection | null
): Promise<PulseItem[]> {
  const watchlist = listWatchlist(db, consumerId);
  const seen = new Set(watchlist.map((r) => `${r.tmdbId}:${r.mediaType === 'tv' ? 'tv' : 'movie'}`));
  const rows: Array<{ tmdbId: number; mediaType: string; title: string; onServer: boolean }> = [
    ...watchlist.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, onServer: r.onServer })),
    ...inFlightRequests(db, consumerId)
      .filter((q) => !seen.has(`${q.tmdbId}:${q.mediaType === 'tv' ? 'tv' : 'movie'}`))
      .map((q) => ({ tmdbId: q.tmdbId, mediaType: q.mediaType, title: q.title, onServer: false }))
  ];
  const out: PulseItem[] = [];
  for (const r of rows) {
    const mediaType = r.mediaType === 'tv' ? 'tv' : 'movie';
    const imdbId = await imdbForTmdb(db, seerr, r.tmdbId, mediaType);
    const st = db.prepare(
      `SELECT dropped_at FROM sync_state
        WHERE consumer_id=? AND spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).get(consumerId, r.tmdbId, mediaType) as any;
    out.push({
      tmdbId: r.tmdbId, mediaType, imdbId, title: r.title,
      onServer: r.onServer, droppedAt: st?.dropped_at ?? null
    });
  }
  return out;
}

/**
 * Build the item pulse writes. The exact payload Stremio accepts for a NEW libraryItem is
 * undocumented, so when the viewer already has items we copy one's field shape verbatim and
 * change only what pulse owns — rather than inventing a structure and hoping.
 * Progress is never inherited from the template: a fresh item starts at zero.
 */
export function buildLibraryItem(
  p: PulseItem,
  template: StremioLibraryItem | null,
  meta: { name: string; poster: string | null } | null
): StremioLibraryItem {
  const now = new Date().toISOString();
  const base: Record<string, unknown> = template ? { ...template } : {};
  const state: Record<string, unknown> = template?.state ? { ...template.state } : {};
  for (const k of Object.keys(state)) {
    if (typeof state[k] === 'number') state[k] = 0;
  }
  return {
    ...base,
    _id: p.imdbId!,
    name: meta?.name ?? p.title,
    type: stremioType(p.mediaType),
    poster: meta?.poster ?? null,
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state
  } as StremioLibraryItem;
}

function markSynced(db: DB, consumerId: number, p: PulseItem, dropped: number | null): void {
  db.prepare(
    `INSERT INTO sync_state(consumer_id,spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES (?,'stremio','watchlist',?,?,?,?)
     ON CONFLICT(consumer_id,spoke,entity,tmdb_id,media_type) DO UPDATE SET
       synced_at=excluded.synced_at, dropped_at=excluded.dropped_at`
  ).run(consumerId, p.tmdbId, p.mediaType, Date.now(), dropped);
}

/** Push stage. Per-consumer isolated: one broken authKey never stalls another viewer. */
export async function pollStremioSync(db: DB): Promise<void> {
  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;

  for (const cred of listEnabled(db, 'stremio')) {
    try {
      const library = await datastoreGet(cred.secret);
      const stremioItems: StremioItem[] = library.map((i) => ({
        imdbId: i._id, type: i.type, removed: i.removed
      }));
      const pulseItems = await loadPulseItems(db, cred.consumerId, seerr);
      const plan = reconcile(pulseItems, stremioItems);

      const byId = new Map(library.map((i) => [i._id, i]));
      const template = library[0] ?? null;
      const changes: StremioLibraryItem[] = [];

      for (const p of plan.push) {
        const meta = await resolveImdbMeta(db, p.imdbId!, stremioType(p.mediaType));
        changes.push(buildLibraryItem(p, template, meta));
        markSynced(db, cred.consumerId, p, null);
      }

      for (const p of plan.remove) {
        const existing = byId.get(p.imdbId!);
        if (!existing) continue;
        // read-modify-write: only `removed` and `_mtime` are ours. Watch progress lives in
        // `state` and is synced across the viewer's devices — clobbering it would erase it.
        changes.push({ ...existing, removed: true, _mtime: new Date().toISOString() });
        markSynced(db, cred.consumerId, p, Date.now());
      }

      for (const p of plan.clearDropped) markSynced(db, cred.consumerId, p, null);

      await datastorePut(cred.secret, changes);
      recordSuccess(db, cred.consumerId, 'stremio');
      if (plan.importItems.length > 0) {
        recordNote(db, cred.consumerId, 'stremio', `${plan.importItems.length} item(s) in Stremio not yet imported`);
      }
    } catch (e) {
      recordFailure(db, cred.consumerId, 'stremio', (e as Error).message);
    }
  }
}
```

Then wire it into the tick. In `src/lib/server/agent/events.ts`, add the import and call it **after** `pollWatchlistAvailability(db)` (a title that just became available must be dropped from Stremio in the same cycle, not the next):

```ts
import { pollStremioSync } from '../consumer/stremio-sync';

// ...after pollWatchlistAvailability(db) and alongside pollTraktHistory(db):
await pollStremioSync(db).catch(() => { /* best-effort */ });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the full suite plus the 5 new tests in this file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/stremio-sync.ts src/lib/server/consumer/stremio-sync.test.ts src/lib/server/agent/events.ts
git commit -m "feat(stremio): push watchlist into the stremio library, wired into the poller"
```

---

### Task 6: Pull stage — import and propagate removals

**Files:**
- Modify: `src/lib/server/consumer/stremio-sync.ts`
- Test: `src/lib/server/consumer/stremio-sync.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 5, plus `addWatchlist` / `removeWatchlist` from `watchlist.ts` (Task 5 already imports `listWatchlist` from the same module — extend that import rather than adding a second one) and `resolveImdbMeta` (Task 1).
- Produces: `applyPull(db, consumerId, plan, capability): Promise<void>` — applies `importItems` and `deleteItems`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/server/consumer/stremio-sync.test.ts`:

```ts
import { listWatchlist } from './watchlist';

it('imports a title the viewer saved in stremio', async () => {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt0903747','series',1396,'Breaking Bad',NULL,1,?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0903747', name: 'Breaking Bad', type: 'series', poster: null,
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);

  const rows = listWatchlist(db, consumerId);
  expect(rows.map((r) => r.tmdbId)).toEqual([1396]);
  expect(rows[0].mediaType).toBe('tv');
});

it('does not import an item whose imdb id cinemeta cannot resolve', async () => {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt404','movie',NULL,NULL,NULL,0,?)`
  ).run(Date.now());
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt404', name: '?', type: 'movie', poster: null,
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('propagates a hand-removal from stremio to the pulse watchlist', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt0111161','movie',278,'Shawshank',NULL,1,?)`
  ).run(Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
        removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('does NOT delete the pulse row when pulse itself dropped the item', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: true });
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt0111161','movie',278,'Shawshank',NULL,1,?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO sync_state(consumer_id,spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES (?,'stremio','watchlist',278,'movie',?,?)`
  ).run(consumerId, Date.now(), Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
        removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' });
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/stremio-sync.test.ts`
Expected: FAIL — imports are not applied and removals are not propagated, so the watchlist assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/server/consumer/stremio-sync.ts`, import the watchlist writers and add `applyPull`, then call it from `pollStremioSync` right before `recordSuccess` (replacing the `recordNote` about un-imported items):

```ts
import { addWatchlist, removeWatchlist } from './watchlist';
import type { ReconcileResult } from './stremio-reconcile';

/**
 * Pull stage. An import needs a tmdb id, which Cinemeta supplies from the imdb id Stremio keys
 * on; an id Cinemeta cannot resolve is skipped rather than guessed at. A hand-removal deletes
 * the pulse row — the reconciler has already excluded removals pulse itself performed.
 */
export async function applyPull(db: DB, consumerId: number, plan: ReconcileResult): Promise<void> {
  for (const s of plan.importItems) {
    const type = s.type === 'series' ? 'series' : 'movie';
    const meta = await resolveImdbMeta(db, s.imdbId, type);
    if (!meta || meta.tmdbId === null) continue; // unresolvable: not an error
    const mediaType = type === 'series' ? 'tv' : 'movie';
    addWatchlist(db, {
      consumerId, tmdbId: meta.tmdbId, mediaType, title: meta.name,
      onServer: false, notifyOnAvailable: true
    });
    db.prepare(
      `INSERT INTO sync_state(consumer_id,spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
       VALUES (?,'stremio','watchlist',?,?,?,NULL)
       ON CONFLICT(consumer_id,spoke,entity,tmdb_id,media_type) DO UPDATE SET synced_at=excluded.synced_at`
    ).run(consumerId, meta.tmdbId, mediaType, Date.now());
  }

  for (const p of plan.deleteItems) {
    removeWatchlist(db, consumerId, p.tmdbId, p.mediaType);
    db.prepare(
      `DELETE FROM sync_state
        WHERE consumer_id=? AND spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).run(consumerId, p.tmdbId, p.mediaType);
  }
}
```

In `pollStremioSync`, replace the `if (plan.importItems.length > 0) recordNote(...)` block with:

```ts
      await applyPull(db, cred.consumerId, plan);
      recordSuccess(db, cred.consumerId, 'stremio');
```

(keeping `datastorePut` before it, so a push failure aborts before the pull mutates anything).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the full suite plus the 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/stremio-sync.ts src/lib/server/consumer/stremio-sync.test.ts
git commit -m "feat(stremio): pull stage - import saved titles, propagate hand-removals"
```

---

## Manual smoke (owner, after Task 6)

Not a code task, and **the first run must be watched** — this is the step that validates the one
documented unknown (the exact new-item payload).

1. Deploy: sync the changed files to `/docker/pulse` on `homelab-docker`, then
   `docker compose up -d --build`. Confirm `curl localhost:3002/` returns 303.
2. Link Stremio in the consumer app with your email and password.
3. **Before trusting a write, read.** Confirm `datastoreGet` returned your real library — the
   orchestrator uses its first item as the field-shape template for anything it creates.
4. Add a title to your pulse watchlist. Within ~2 minutes it should appear in Stremio's Library
   on desktop AND on the TV (the Library is account state, so both clients see it).
5. Remove that title in Stremio by hand. On the next cycle it should disappear from the pulse
   watchlist.
6. Add a different title in Stremio. It should appear on the pulse watchlist within a cycle.
7. **Check nothing was clobbered:** open something you had partly watched in Stremio and confirm
   your progress is still there. The push path is read-modify-write specifically to protect that
   `state` object; this is the check that proves it.

## Not in this plan

- **Playback progress sync** (the monotonic `state.time_offset` rule from the hub spec) — a
  follow-up plan, so this one stays a watchlist feature.
- Ratings and watched history: Stremio has no field for either.
- Anything Trakt: that spoke is built, deployed and inert pending credentials.
