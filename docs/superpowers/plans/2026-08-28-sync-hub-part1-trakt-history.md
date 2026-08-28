# Sync Hub Part 1 — Play Ingest + Trakt History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pulse ingests finished plays from Tautulli into its own play log, and pushes them to each linked consumer's Trakt account.

**Architecture:** Tautulli is a read-only source. Plays land in a new `watch_plays` table, deduped by Tautulli's `row_id`. A Trakt spoke reads that table and pushes plays Trakt doesn't already have. All of it runs inside the existing `startEventPoller`. Credentials are per-consumer and encrypted.

**Tech Stack:** SvelteKit 2 / Svelte 5, TypeScript, better-sqlite3, zod 4, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-28-sync-hub-design.md`

## Global Constraints

- Tests: `npm test` (vitest). Tests open an in-memory DB via `openDb(':memory:')` then `migrate(db)`. **Never** point a test at the real `pulse.sqlite`.
- Secrets are encrypted at rest with `encryptSecret` / `decryptSecret` from `src/lib/server/crypto.ts`. Passwords and client secrets are never persisted in plaintext, never logged.
- Schema changes go in the single `migrate()` statement block in `src/lib/server/db.ts`, always `CREATE TABLE IF NOT EXISTS`. There is no migration framework — the block is re-run on every boot and must stay idempotent.
- Every external call is validated with `zod` before its result is used. A validation failure aborts the write; it never falls through to a partial write.
- New consumer-facing routes are consumer-session-gated and **must not** be added to `CONSUMER_PUBLIC` in `src/hooks.server.ts`.
- User-visible copy goes in **both** `src/lib/i18n/en.json` and `src/lib/i18n/pt-BR.json`. pt-BR strings stay direct and plain — no translated corporate idiom.
- Commit after every task. This repo is `master`, personal — **no assistant trailers or co-author lines in commit messages.**
- Trakt required headers on every call: `Content-Type: application/json`, `trakt-api-version: 2`, `trakt-api-key: <client_id>`, plus `Authorization: Bearer <access_token>` on authenticated endpoints. The existing `http.ts` helpers send `X-Api-Key` and are therefore **not** reusable here.

## Prerequisite (owner action, not a code task)

Register a Trakt application at `https://trakt.tv/oauth/applications`. Use redirect URI
`urn:ietf:wg:oauth:2.0:oob` (device flow). Put the resulting values in the pulse container env:

```
PULSE_TRAKT_CLIENT_ID=...
PULSE_TRAKT_CLIENT_SECRET=...
```

Without these, Task 3 onward cannot be smoke-tested against the real service. Unit tests do not need them.

---

### Task 1: Database schema

**Files:**
- Modify: `src/lib/server/db.ts` (append inside the existing `migrate()` statement block)
- Test: `src/lib/server/db.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `watch_plays`, `spoke_credentials`, `sync_state`, `consumer_ratings`. All later tasks read/write these.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/server/db.test.ts`:

```ts
it('migrate creates the sync hub tables', () => {
  const db = openDb(':memory:');
  migrate(db);
  const names = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table'"
  ).all() as Array<{ name: string }>).map((r) => r.name);
  expect(names).toContain('watch_plays');
  expect(names).toContain('spoke_credentials');
  expect(names).toContain('sync_state');
  expect(names).toContain('consumer_ratings');
});

it('watch_plays rejects a duplicate (consumer, source, source_row)', () => {
  const db = openDb(':memory:');
  migrate(db);
  const ins = db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  ins.run(1, 550, 'tt0137523', 'movie', null, null, 1000, 'tautulli', 42);
  expect(() => ins.run(1, 550, 'tt0137523', 'movie', null, null, 2000, 'tautulli', 42)).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/db.test.ts`
Expected: FAIL — `expect(names).toContain('watch_plays')` fails because the table does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/lib/server/db.ts`, append inside the same `db.exec(\`...\`)` block used by the existing `CREATE TABLE IF NOT EXISTS` statements:

```sql
CREATE TABLE IF NOT EXISTS watch_plays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  tmdb_id      INTEGER,
  imdb_id      TEXT,
  media_type   TEXT NOT NULL,
  season       INTEGER,
  episode      INTEGER,
  watched_at   INTEGER NOT NULL,
  source       TEXT NOT NULL,
  source_row   INTEGER,
  UNIQUE(consumer_id, source, source_row)
);
CREATE INDEX IF NOT EXISTS idx_watch_plays_consumer ON watch_plays(consumer_id, watched_at);

CREATE TABLE IF NOT EXISTS spoke_credentials (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  spoke        TEXT NOT NULL,
  secret       TEXT NOT NULL,
  refresh      TEXT,
  expires_at   INTEGER,
  enabled      INTEGER NOT NULL DEFAULT 1,
  fail_count   INTEGER NOT NULL DEFAULT 0,
  last_sync_at INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (consumer_id, spoke)
);

CREATE TABLE IF NOT EXISTS sync_state (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  spoke        TEXT NOT NULL,
  entity       TEXT NOT NULL,
  tmdb_id      INTEGER NOT NULL,
  media_type   TEXT NOT NULL,
  synced_at    INTEGER,
  dropped_at   INTEGER,
  PRIMARY KEY (consumer_id, spoke, entity, tmdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS consumer_ratings (
  consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
  tmdb_id      INTEGER NOT NULL,
  media_type   TEXT NOT NULL,
  rating       INTEGER NOT NULL,
  rated_at     INTEGER NOT NULL,
  PRIMARY KEY (consumer_id, tmdb_id, media_type)
);

CREATE TABLE IF NOT EXISTS plex_guid_cache (
  rating_key   TEXT PRIMARY KEY,
  tmdb_id      INTEGER,
  imdb_id      TEXT,
  cached_at    INTEGER NOT NULL
);
```

`plex_guid_cache` is used by Task 4 — a `rating_key`'s external ids never change, so the cache never expires.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/db.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/db.ts src/lib/server/db.test.ts
git commit -m "feat(db): sync hub tables (watch_plays, spoke_credentials, sync_state, ratings)"
```

---

### Task 2: Spoke credential store

**Files:**
- Create: `src/lib/server/consumer/spoke-credentials.ts`
- Test: `src/lib/server/consumer/spoke-credentials.test.ts`

**Interfaces:**
- Consumes: `spoke_credentials` (Task 1), `encryptSecret`/`decryptSecret` from `../crypto`.
- Produces:
  - `type SpokeId = 'trakt' | 'stremio'`
  - `interface SpokeCredential { consumerId: number; spoke: SpokeId; secret: string; refresh: string | null; expiresAt: number | null; enabled: boolean; failCount: number; lastSyncAt: number | null; lastError: string | null }`
  - `saveCredential(db, c: { consumerId: number; spoke: SpokeId; secret: string; refresh?: string | null; expiresAt?: number | null }): void`
  - `getCredential(db, consumerId: number, spoke: SpokeId): SpokeCredential | null`
  - `listEnabled(db, spoke: SpokeId): SpokeCredential[]`
  - `deleteCredential(db, consumerId: number, spoke: SpokeId): void`
  - `recordSuccess(db, consumerId: number, spoke: SpokeId): void`
  - `recordFailure(db, consumerId: number, spoke: SpokeId, message: string): void`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/consumer/spoke-credentials.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  saveCredential, getCredential, listEnabled, deleteCredential,
  recordSuccess, recordFailure
} from './spoke-credentials';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('stores the secret encrypted but returns it decrypted', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'access-abc', refresh: 'refresh-xyz' });
  const raw = db.prepare('SELECT secret FROM spoke_credentials WHERE consumer_id=1').get() as any;
  expect(raw.secret).not.toBe('access-abc');
  expect(getCredential(db, 1, 'trakt')?.secret).toBe('access-abc');
  expect(getCredential(db, 1, 'trakt')?.refresh).toBe('refresh-xyz');
});

it('save is an upsert on (consumer, spoke)', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'one' });
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'two' });
  expect(listEnabled(db, 'trakt')).toHaveLength(1);
  expect(getCredential(db, 1, 'trakt')?.secret).toBe('two');
});

it('five consecutive failures disables the credential; success resets the count', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  for (let i = 0; i < 4; i++) recordFailure(db, 1, 'trakt', 'boom');
  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(true);
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(4);
  recordFailure(db, 1, 'trakt', 'boom');
  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(false);
  expect(listEnabled(db, 'trakt')).toHaveLength(0);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  recordSuccess(db, 1, 'trakt');
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(0);
  expect(getCredential(db, 1, 'trakt')?.enabled).toBe(true);
});

it('listEnabled is scoped to one spoke', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  saveCredential(db, { consumerId: 2, spoke: 'stremio', secret: 'b' });
  expect(listEnabled(db, 'trakt').map((c) => c.consumerId)).toEqual([1]);
});

it('delete removes only that consumer + spoke', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  saveCredential(db, { consumerId: 1, spoke: 'stremio', secret: 'b' });
  deleteCredential(db, 1, 'trakt');
  expect(getCredential(db, 1, 'trakt')).toBeNull();
  expect(getCredential(db, 1, 'stremio')).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/spoke-credentials.test.ts`
Expected: FAIL — cannot resolve `./spoke-credentials`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/consumer/spoke-credentials.ts`:

```ts
import type { DB } from '../db';
import { encryptSecret, decryptSecret } from '../crypto';

export type SpokeId = 'trakt' | 'stremio';

/** After this many consecutive failures a credential is disabled and the viewer is asked to relink. */
export const MAX_FAILS = 5;

export interface SpokeCredential {
  consumerId: number;
  spoke: SpokeId;
  secret: string;
  refresh: string | null;
  expiresAt: number | null;
  enabled: boolean;
  failCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

function rowOf(r: any): SpokeCredential {
  return {
    consumerId: r.consumer_id,
    spoke: r.spoke,
    secret: decryptSecret(r.secret),
    refresh: r.refresh != null ? decryptSecret(r.refresh) : null,
    expiresAt: r.expires_at ?? null,
    enabled: !!r.enabled,
    failCount: r.fail_count,
    lastSyncAt: r.last_sync_at ?? null,
    lastError: r.last_error ?? null
  };
}

export function saveCredential(db: DB, c: {
  consumerId: number; spoke: SpokeId; secret: string;
  refresh?: string | null; expiresAt?: number | null;
}): void {
  db.prepare(
    `INSERT INTO spoke_credentials(consumer_id,spoke,secret,refresh,expires_at,enabled,fail_count,created_at)
     VALUES (?,?,?,?,?,1,0,?)
     ON CONFLICT(consumer_id,spoke) DO UPDATE SET
       secret=excluded.secret, refresh=excluded.refresh, expires_at=excluded.expires_at,
       enabled=1, fail_count=0, last_error=NULL`
  ).run(
    c.consumerId, c.spoke, encryptSecret(c.secret),
    c.refresh != null ? encryptSecret(c.refresh) : null,
    c.expiresAt ?? null, Date.now()
  );
}

export function getCredential(db: DB, consumerId: number, spoke: SpokeId): SpokeCredential | null {
  const r = db.prepare('SELECT * FROM spoke_credentials WHERE consumer_id=? AND spoke=?')
    .get(consumerId, spoke) as any;
  return r ? rowOf(r) : null;
}

export function listEnabled(db: DB, spoke: SpokeId): SpokeCredential[] {
  return (db.prepare('SELECT * FROM spoke_credentials WHERE spoke=? AND enabled=1')
    .all(spoke) as any[]).map(rowOf);
}

export function deleteCredential(db: DB, consumerId: number, spoke: SpokeId): void {
  db.prepare('DELETE FROM spoke_credentials WHERE consumer_id=? AND spoke=?').run(consumerId, spoke);
}

export function recordSuccess(db: DB, consumerId: number, spoke: SpokeId): void {
  db.prepare('UPDATE spoke_credentials SET fail_count=0, last_error=NULL, last_sync_at=? WHERE consumer_id=? AND spoke=?')
    .run(Date.now(), consumerId, spoke);
}

export function recordFailure(db: DB, consumerId: number, spoke: SpokeId, message: string): void {
  db.prepare(
    `UPDATE spoke_credentials
        SET fail_count = fail_count + 1,
            last_error = ?,
            enabled = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE enabled END
      WHERE consumer_id=? AND spoke=?`
  ).run(message.slice(0, 500), MAX_FAILS, consumerId, spoke);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/consumer/spoke-credentials.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/spoke-credentials.ts src/lib/server/consumer/spoke-credentials.test.ts
git commit -m "feat(sync): per-consumer encrypted spoke credential store"
```

---

### Task 3: Trakt client — device OAuth

**Files:**
- Create: `src/lib/server/integrations/trakt.ts`
- Test: `src/lib/server/integrations/trakt.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure HTTP client).
- Produces:
  - `traktConfigured(): boolean`
  - `requestDeviceCode(): Promise<{ deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }>`
  - `pollDeviceToken(deviceCode: string): Promise<{ status: 'pending' } | { status: 'ok'; accessToken: string; refreshToken: string; expiresAt: number } | { status: 'expired' }>`
  - `refreshToken(refresh: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: number }>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/integrations/trakt.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { requestDeviceCode, pollDeviceToken, refreshToken, traktConfigured } from './trakt';

const realFetch = global.fetch;
beforeEach(() => {
  process.env.PULSE_TRAKT_CLIENT_ID = 'cid';
  process.env.PULSE_TRAKT_CLIENT_SECRET = 'csec';
});
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function mockFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' }
  }));
  global.fetch = spy as any;
  return spy;
}

it('traktConfigured is false without env', () => {
  delete process.env.PULSE_TRAKT_CLIENT_ID;
  expect(traktConfigured()).toBe(false);
});

it('requestDeviceCode maps the Trakt payload and sends the client id', async () => {
  const spy = mockFetch(200, {
    device_code: 'dc', user_code: 'ABC123',
    verification_url: 'https://trakt.tv/activate', expires_in: 600, interval: 5
  });
  const r = await requestDeviceCode();
  expect(r).toEqual({
    deviceCode: 'dc', userCode: 'ABC123',
    verificationUrl: 'https://trakt.tv/activate', expiresIn: 600, interval: 5
  });
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/oauth/device/code');
  expect(JSON.parse(init.body)).toEqual({ client_id: 'cid' });
});

it('pollDeviceToken returns pending on 400', async () => {
  mockFetch(400, {});
  expect(await pollDeviceToken('dc')).toEqual({ status: 'pending' });
});

it('pollDeviceToken returns expired on 410', async () => {
  mockFetch(410, {});
  expect(await pollDeviceToken('dc')).toEqual({ status: 'expired' });
});

it('pollDeviceToken maps a successful token exchange', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(1_000_000));
  mockFetch(200, {
    access_token: 'at', refresh_token: 'rt', expires_in: 7200
  });
  const r = await pollDeviceToken('dc');
  expect(r).toEqual({
    status: 'ok', accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000_000 + 7200 * 1000
  });
  vi.useRealTimers();
});

it('a malformed token response is rejected rather than returned', async () => {
  mockFetch(200, { access_token: 'at' }); // no refresh_token / expires_in
  await expect(pollDeviceToken('dc')).rejects.toThrow();
});

it('refreshToken posts the refresh grant', async () => {
  const spy = mockFetch(200, { access_token: 'a2', refresh_token: 'r2', expires_in: 60 });
  await refreshToken('r1');
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/oauth/token');
  expect(JSON.parse(init.body)).toMatchObject({
    refresh_token: 'r1', client_id: 'cid', client_secret: 'csec', grant_type: 'refresh_token'
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/integrations/trakt.test.ts`
Expected: FAIL — cannot resolve `./trakt`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/integrations/trakt.ts`:

```ts
import { z } from 'zod';

const API = 'https://api.trakt.tv';
const OOB = 'urn:ietf:wg:oauth:2.0:oob';

function clientId(): string { return (process.env.PULSE_TRAKT_CLIENT_ID ?? '').trim(); }
function clientSecret(): string { return (process.env.PULSE_TRAKT_CLIENT_SECRET ?? '').trim(); }

export function traktConfigured(): boolean {
  return clientId() !== '' && clientSecret() !== '';
}

/** Headers every Trakt call needs. `http.ts` sends X-Api-Key and is not usable here. */
export function traktHeaders(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': clientId()
  };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

async function post(path: string, body: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: traktHeaders(accessToken),
    body: JSON.stringify(body)
  });
}

const DeviceCode = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_url: z.string(),
  expires_in: z.number(),
  interval: z.number()
});

export async function requestDeviceCode() {
  const res = await post('/oauth/device/code', { client_id: clientId() });
  if (!res.ok) throw new Error(`Trakt device code HTTP ${res.status}`);
  const d = DeviceCode.parse(await res.json());
  return {
    deviceCode: d.device_code,
    userCode: d.user_code,
    verificationUrl: d.verification_url,
    expiresIn: d.expires_in,
    interval: d.interval
  };
}

const Token = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number()
});

export type DevicePoll =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'ok'; accessToken: string; refreshToken: string; expiresAt: number };

export async function pollDeviceToken(deviceCode: string): Promise<DevicePoll> {
  const res = await post('/oauth/device/token', {
    code: deviceCode, client_id: clientId(), client_secret: clientSecret()
  });
  // Trakt device flow: 400 = still pending, 410 = expired, 409 = already used, 418 = denied.
  if (res.status === 400) return { status: 'pending' };
  if (res.status === 410 || res.status === 409 || res.status === 418) return { status: 'expired' };
  if (!res.ok) throw new Error(`Trakt device token HTTP ${res.status}`);
  const t = Token.parse(await res.json());
  return {
    status: 'ok',
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000
  };
}

export async function refreshToken(refresh: string) {
  const res = await post('/oauth/token', {
    refresh_token: refresh,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: OOB,
    grant_type: 'refresh_token'
  });
  if (!res.ok) throw new Error(`Trakt refresh HTTP ${res.status}`);
  const t = Token.parse(await res.json());
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/integrations/trakt.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/integrations/trakt.ts src/lib/server/integrations/trakt.test.ts
git commit -m "feat(trakt): device oauth client (code request, poll, refresh)"
```

---

### Task 4: Tautulli play ingest

**Files:**
- Create: `src/lib/server/consumer/plays-ingest.ts`
- Test: `src/lib/server/consumer/plays-ingest.test.ts`

**Interfaces:**
- Consumes: `watch_plays` + `plex_guid_cache` (Task 1); `Connection` from `../connections`.
- Produces:
  - `interface RawPlay { rowId: number; ratingKey: string; plexUserId: string; mediaType: string; watchedStatus: number; stoppedAt: number; season: number | null; episode: number | null }`
  - `parseHistoryRows(data: unknown): RawPlay[]`
  - `resolveIds(db, conn, ratingKey): Promise<{ tmdbId: number | null; imdbId: string | null }>`
  - `ingestPlays(db, conn, opts?: { pageSize?: number }): Promise<number>` — returns rows inserted
  - `highestSourceRow(db, source: string): number`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/consumer/plays-ingest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { parseHistoryRows, resolveIds, ingestPlays, highestSourceRow } from './plays-ingest';
import type { Connection } from '../connections';

const conn: Connection = {
  id: 1, type: 'tautulli', name: 'Tautulli', baseUrl: 'http://tautulli:8181',
  secret: 'key', options: {}, enabled: true
};

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (1,?,?)')
    .run('viewer', Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (1,1,'Jader','plex-1','active',?)`
  ).run(Date.now());
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('parseHistoryRows keeps only finished plays and maps season/episode', () => {
  const rows = parseHistoryRows({
    response: { result: 'success', data: { data: [
      { row_id: 7, rating_key: '900', user_id: 'plex-1', media_type: 'episode',
        watched_status: 1, stopped: 1700, parent_media_index: '2', media_index: '5' },
      { row_id: 8, rating_key: '901', user_id: 'plex-1', media_type: 'movie',
        watched_status: 0, stopped: 1800, parent_media_index: null, media_index: null }
    ] } }
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ rowId: 7, ratingKey: '900', season: 2, episode: 5 });
});

it('resolveIds reads guids from get_metadata and caches them', async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify({
    response: { result: 'success', data: { guids: ['imdb://tt0111161', 'tmdb://278'] } }
  }), { status: 200 }));
  global.fetch = spy as any;

  expect(await resolveIds(db, conn, '900')).toEqual({ tmdbId: 278, imdbId: 'tt0111161' });
  expect(await resolveIds(db, conn, '900')).toEqual({ tmdbId: 278, imdbId: 'tt0111161' });
  expect(spy).toHaveBeenCalledTimes(1); // second call served from plex_guid_cache
});

it('ingestPlays skips plays whose plex user matches no consumer', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 1, rating_key: '900', user_id: 'someone-else', media_type: 'movie',
          watched_status: 1, stopped: 1700, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['imdb://tt1', 'tmdb://1'] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(0);
  expect(db.prepare('SELECT COUNT(*) c FROM watch_plays').get()).toMatchObject({ c: 0 });
});

it('ingestPlays inserts once and is idempotent on re-run', async () => {
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).includes('get_history')) {
      return new Response(JSON.stringify({ response: { result: 'success', data: { data: [
        { row_id: 5, rating_key: '900', user_id: 'plex-1', media_type: 'movie',
          watched_status: 1, stopped: 1700, parent_media_index: null, media_index: null }
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({
      response: { result: 'success', data: { guids: ['imdb://tt0111161', 'tmdb://278'] } }
    }), { status: 200 });
  }) as any);

  expect(await ingestPlays(db, conn)).toBe(1);
  expect(await ingestPlays(db, conn)).toBe(0);
  const row = db.prepare('SELECT * FROM watch_plays').get() as any;
  expect(row).toMatchObject({
    consumer_id: 1, tmdb_id: 278, imdb_id: 'tt0111161',
    media_type: 'movie', watched_at: 1700 * 1000, source: 'tautulli', source_row: 5
  });
  expect(highestSourceRow(db, 'tautulli')).toBe(5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/plays-ingest.test.ts`
Expected: FAIL — cannot resolve `./plays-ingest`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/consumer/plays-ingest.ts`:

```ts
import { z } from 'zod';
import type { DB } from '../db';
import type { Connection } from '../connections';

export interface RawPlay {
  rowId: number;
  ratingKey: string;
  plexUserId: string;
  mediaType: string;
  watchedStatus: number;
  stoppedAt: number;   // seconds, as Tautulli reports it
  season: number | null;
  episode: number | null;
}

const HistoryEnvelope = z.object({
  response: z.object({
    result: z.string(),
    data: z.object({ data: z.array(z.record(z.string(), z.unknown())) })
  })
});

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Finished plays only. A partial play is not history. */
export function parseHistoryRows(data: unknown): RawPlay[] {
  const parsed = HistoryEnvelope.parse(data);
  if (parsed.response.result !== 'success') throw new Error('Tautulli error');
  return parsed.response.data.data
    .filter((r: any) => Number(r.watched_status ?? 0) === 1)
    .map((r: any) => ({
      rowId: Number(r.row_id),
      ratingKey: String(r.rating_key),
      plexUserId: String(r.user_id ?? ''),
      mediaType: String(r.media_type ?? ''),
      watchedStatus: Number(r.watched_status ?? 0),
      stoppedAt: Number(r.stopped ?? 0),
      season: num(r.parent_media_index),
      episode: num(r.media_index)
    }));
}

function cmdUrl(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): string {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function call(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): Promise<any> {
  const res = await fetch(cmdUrl(conn, cmd, extra), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  return res.json();
}

const MetadataEnvelope = z.object({
  response: z.object({
    result: z.string(),
    data: z.object({ guids: z.array(z.string()).optional() })
  })
});

/**
 * External ids for a rating_key, via get_metadata's `guids` array. Plex's per-row `guid` is
 * agent-dependent and unreliable, so this is the only source we trust. Cached permanently —
 * a rating_key's ids never change.
 */
export async function resolveIds(
  db: DB, conn: Connection, ratingKey: string
): Promise<{ tmdbId: number | null; imdbId: string | null }> {
  const cached = db.prepare('SELECT tmdb_id, imdb_id FROM plex_guid_cache WHERE rating_key=?')
    .get(ratingKey) as any;
  if (cached) return { tmdbId: cached.tmdb_id ?? null, imdbId: cached.imdb_id ?? null };

  const parsed = MetadataEnvelope.parse(await call(conn, 'get_metadata', { rating_key: ratingKey }));
  const guids = parsed.response.data.guids ?? [];
  const imdb = guids.find((g) => g.startsWith('imdb://'))?.slice('imdb://'.length) ?? null;
  const tmdbRaw = guids.find((g) => g.startsWith('tmdb://'))?.slice('tmdb://'.length) ?? null;
  const tmdbId = tmdbRaw !== null ? num(tmdbRaw) : null;

  db.prepare('INSERT OR REPLACE INTO plex_guid_cache(rating_key,tmdb_id,imdb_id,cached_at) VALUES (?,?,?,?)')
    .run(ratingKey, tmdbId, imdb, Date.now());
  return { tmdbId, imdbId: imdb };
}

export function highestSourceRow(db: DB, source: string): number {
  const r = db.prepare('SELECT MAX(source_row) m FROM watch_plays WHERE source=?').get(source) as any;
  return Number(r?.m ?? 0);
}

/** Plex user id -> consumer id, from the existing consumer_users.plex_account_id mapping. */
function plexUserMap(db: DB): Map<string, number> {
  const rows = db.prepare(
    "SELECT id, plex_account_id FROM consumer_users WHERE plex_account_id IS NOT NULL AND plex_account_id <> ''"
  ).all() as any[];
  return new Map(rows.map((r) => [String(r.plex_account_id), Number(r.id)]));
}

/**
 * Pull finished plays from Tautulli into watch_plays. Returns the number of rows inserted.
 *
 * Per-user filtering is a correctness requirement, not a nicety: Tautulli's history covers
 * everyone on the server, and a mis-attributed row would publish someone else's viewing to a
 * viewer's public Trakt profile. A play whose plex user matches no linked consumer is dropped.
 */
export async function ingestPlays(
  db: DB, conn: Connection, opts: { pageSize?: number } = {}
): Promise<number> {
  const pageSize = opts.pageSize ?? 200;
  const cursor = highestSourceRow(db, 'tautulli');
  const users = plexUserMap(db);
  if (users.size === 0) return 0;

  const rows = parseHistoryRows(await call(conn, 'get_history', { length: pageSize }))
    .filter((p) => p.rowId > cursor)
    .filter((p) => users.has(p.plexUserId));

  const insert = db.prepare(
    `INSERT OR IGNORE INTO watch_plays
       (consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );

  let inserted = 0;
  for (const p of rows) {
    try {
      const ids = await resolveIds(db, conn, p.ratingKey);
      if (ids.tmdbId === null && ids.imdbId === null) continue; // unresolvable: never syncs, not an error
      const mediaType = p.mediaType === 'episode' ? 'tv' : 'movie';
      const info = insert.run(
        users.get(p.plexUserId)!, ids.tmdbId, ids.imdbId, mediaType,
        p.season, p.episode, p.stoppedAt * 1000, 'tautulli', p.rowId
      );
      inserted += info.changes;
    } catch {
      // one bad title never blocks the rest — matches pollWatchlistAvailability's contract
    }
  }
  return inserted;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/consumer/plays-ingest.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/plays-ingest.ts src/lib/server/consumer/plays-ingest.test.ts
git commit -m "feat(sync): tautulli play ingest with cached guid resolution + per-user filtering"
```

---

### Task 5: Trakt history read + write

**Files:**
- Modify: `src/lib/server/integrations/trakt.ts`
- Test: `src/lib/server/integrations/trakt.test.ts` (append)

**Interfaces:**
- Consumes: `traktHeaders` (Task 3).
- Produces:
  - `interface TraktPlay { tmdbId: number | null; imdbId: string | null; mediaType: 'movie' | 'tv'; season: number | null; episode: number | null; watchedAt: number }`
  - `getWatchedIds(accessToken: string, type: 'movies' | 'shows'): Promise<Set<string>>` — keys are `imdb:<id>` / `tmdb:<id>`, plus `:s<season>e<episode>` for episodes
  - `addToHistory(accessToken: string, plays: TraktPlay[]): Promise<void>`
  - `playKey(p: TraktPlay): string[]` — the id keys a play is matched by; used by Task 7

- [ ] **Step 1: Write the failing test**

Append to `src/lib/server/integrations/trakt.test.ts`:

```ts
import { getWatchedIds, addToHistory } from './trakt';

it('getWatchedIds indexes movies by imdb and tmdb', async () => {
  mockFetch(200, [
    { movie: { ids: { imdb: 'tt0111161', tmdb: 278 } } },
    { movie: { ids: { imdb: null, tmdb: 999 } } }
  ]);
  const ids = await getWatchedIds('at', 'movies');
  expect(ids.has('imdb:tt0111161')).toBe(true);
  expect(ids.has('tmdb:278')).toBe(true);
  expect(ids.has('tmdb:999')).toBe(true);
});

it('getWatchedIds indexes episodes by season and number', async () => {
  mockFetch(200, [
    { show: { ids: { tmdb: 1396 } }, seasons: [
      { number: 2, episodes: [{ number: 5 }, { number: 6 }] }
    ] }
  ]);
  const ids = await getWatchedIds('at', 'shows');
  expect(ids.has('tmdb:1396:s2e5')).toBe(true);
  expect(ids.has('tmdb:1396:s2e6')).toBe(true);
  expect(ids.has('tmdb:1396:s2e7')).toBe(false);
});

it('addToHistory nests tv plays under the show, and keeps movies flat', async () => {
  const spy = mockFetch(201, { added: { movies: 1, episodes: 2 } });
  await addToHistory('at', [
    { tmdbId: 278, imdbId: 'tt0111161', mediaType: 'movie', season: null, episode: null, watchedAt: 1_000_000 },
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 5, watchedAt: 2_000_000 },
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 6, watchedAt: 3_000_000 }
  ]);
  const [url, init] = spy.mock.calls[0] as any;
  expect(url).toBe('https://api.trakt.tv/sync/history');
  const body = JSON.parse(init.body);
  expect(body.movies).toEqual([
    { watched_at: new Date(1_000_000).toISOString(), ids: { imdb: 'tt0111161', tmdb: 278 } }
  ]);
  // Both episodes collapse into ONE show entry, one season, two episodes.
  expect(body.shows).toEqual([
    {
      ids: { tmdb: 1396 },
      seasons: [
        {
          number: 2,
          episodes: [
            { number: 5, watched_at: new Date(2_000_000).toISOString() },
            { number: 6, watched_at: new Date(3_000_000).toISOString() }
          ]
        }
      ]
    }
  ]);
  expect(body.episodes).toBeUndefined();
  expect(init.headers.Authorization).toBe('Bearer at');
});

it('addToHistory skips a tv play with no season/episode rather than mis-posting it', async () => {
  const spy = mockFetch(201, {});
  await addToHistory('at', [
    { tmdbId: 1396, imdbId: null, mediaType: 'tv', season: null, episode: null, watchedAt: 2_000_000 }
  ]);
  const body = JSON.parse((spy.mock.calls[0] as any)[1].body);
  expect(body.shows).toEqual([]);
  expect(body.movies).toEqual([]);
});

it('addToHistory does nothing when given no plays', async () => {
  const spy = mockFetch(201, {});
  await addToHistory('at', []);
  expect(spy).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/integrations/trakt.test.ts`
Expected: FAIL — `getWatchedIds` / `addToHistory` are not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/server/integrations/trakt.ts`:

```ts
export interface TraktPlay {
  tmdbId: number | null;
  imdbId: string | null;
  mediaType: 'movie' | 'tv';
  season: number | null;
  episode: number | null;
  watchedAt: number; // ms epoch
}

/** Stable key for "does Trakt already have this play". */
export function playKey(p: TraktPlay): string[] {
  const suffix = p.mediaType === 'tv' && p.season !== null && p.episode !== null
    ? `:s${p.season}e${p.episode}` : '';
  const keys: string[] = [];
  if (p.imdbId) keys.push(`imdb:${p.imdbId}${suffix}`);
  if (p.tmdbId !== null) keys.push(`tmdb:${p.tmdbId}${suffix}`);
  return keys;
}

/**
 * The set of plays Trakt already has. Used to make history sync a gap-filler: the scrobble
 * path (Part 1 of the spec's stage 3) also writes history, so pushing everything would double up.
 */
export async function getWatchedIds(accessToken: string, type: 'movies' | 'shows'): Promise<Set<string>> {
  const res = await fetch(`${API}/sync/watched/${type}`, { headers: traktHeaders(accessToken) });
  if (!res.ok) throw new Error(`Trakt watched HTTP ${res.status}`);
  const body = await res.json();
  const out = new Set<string>();
  if (!Array.isArray(body)) throw new Error('Trakt watched: expected an array');

  for (const entry of body) {
    if (type === 'movies') {
      const ids = entry?.movie?.ids ?? {};
      if (ids.imdb) out.add(`imdb:${ids.imdb}`);
      if (ids.tmdb != null) out.add(`tmdb:${ids.tmdb}`);
      continue;
    }
    const ids = entry?.show?.ids ?? {};
    for (const season of entry?.seasons ?? []) {
      for (const ep of season?.episodes ?? []) {
        const suffix = `:s${season.number}e${ep.number}`;
        if (ids.imdb) out.add(`imdb:${ids.imdb}${suffix}`);
        if (ids.tmdb != null) out.add(`tmdb:${ids.tmdb}${suffix}`);
      }
    }
  }
  return out;
}

function idsOf(p: TraktPlay): Record<string, string | number> {
  const ids: Record<string, string | number> = {};
  if (p.imdbId) ids.imdb = p.imdbId;
  if (p.tmdbId !== null) ids.tmdb = p.tmdbId;
  return ids;
}

interface ShowEntry {
  ids: Record<string, string | number>;
  seasons: Map<number, Array<{ number: number; watched_at: string }>>;
}

export async function addToHistory(accessToken: string, plays: TraktPlay[]): Promise<void> {
  if (plays.length === 0) return;

  const movies = plays
    .filter((p) => p.mediaType === 'movie')
    .map((p) => ({ watched_at: new Date(p.watchedAt).toISOString(), ids: idsOf(p) }));

  // TV plays are grouped under the SHOW, with seasons and episodes nested. That is the shape
  // Trakt's history endpoint accepts, and it is the same shape /sync/watched/shows returns —
  // so a pushed play and the watched-set comparison agree on one key. A flat `episodes` array
  // keyed by show ids would be silently mis-synced (Trakt would mark the whole show watched).
  const shows = new Map<string, ShowEntry>();
  for (const p of plays) {
    if (p.mediaType !== 'tv' || p.season === null || p.episode === null) continue;
    const key = p.imdbId ?? (p.tmdbId !== null ? `tmdb:${p.tmdbId}` : '');
    if (key === '') continue; // unidentifiable: never synced, not an error
    let entry = shows.get(key);
    if (!entry) { entry = { ids: idsOf(p), seasons: new Map() }; shows.set(key, entry); }
    const eps = entry.seasons.get(p.season) ?? [];
    eps.push({ number: p.episode, watched_at: new Date(p.watchedAt).toISOString() });
    entry.seasons.set(p.season, eps);
  }

  const body = {
    movies,
    shows: [...shows.values()].map((s) => ({
      ids: s.ids,
      seasons: [...s.seasons.entries()].map(([number, episodes]) => ({ number, episodes }))
    }))
  };

  const res = await fetch(`${API}/sync/history`, {
    method: 'POST',
    headers: traktHeaders(accessToken),
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Trakt history HTTP ${res.status}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/lib/server/integrations/trakt.test.ts`
Expected: PASS (11 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/integrations/trakt.ts src/lib/server/integrations/trakt.test.ts
git commit -m "feat(trakt): watched-set read and history write"
```

---

### Task 6: Trakt link/unlink endpoint

**Files:**
- Create: `src/routes/api/app/trakt/+server.ts`
- Create: `src/routes/api/app/trakt/server.test.ts`
- Modify: `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json`

**Interfaces:**
- Consumes: `requestDeviceCode`, `pollDeviceToken`, `traktConfigured` (Task 3); `saveCredential`, `getCredential`, `deleteCredential` (Task 2).
- Produces: `GET /api/app/trakt` (status), `POST /api/app/trakt` (`{ action: 'start' }` → device code; `{ action: 'poll', deviceCode }` → link result), `DELETE /api/app/trakt` (unlink).

- [ ] **Step 1: Write the failing test**

Create `src/routes/api/app/trakt/server.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { getCredential, saveCredential } from '$lib/server/consumer/spoke-credentials';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
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
    locals: { consumer: { id: 1 } },
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
    locals: { consumer: { id: 1 } },
    request: new Request('http://x', { method: 'POST', body: JSON.stringify({ action: 'poll', deviceCode: 'dc' }) })
  } as any);
  expect(await res.json()).toMatchObject({ status: 'ok' });
  expect(getCredential(db, 1, 'trakt')?.secret).toBe('at');
});

it('delete unlinks', async () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at' });
  const { DELETE } = await handlers();
  await DELETE({ locals: { consumer: { id: 1 } } } as any);
  expect(getCredential(db, 1, 'trakt')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/routes/api/app/trakt/server.test.ts`
Expected: FAIL — cannot resolve `./+server`.

- [ ] **Step 3: Write minimal implementation**

Create `src/routes/api/app/trakt/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { requestDeviceCode, pollDeviceToken, traktConfigured } from '$lib/server/integrations/trakt';
import { saveCredential, getCredential, deleteCredential } from '$lib/server/consumer/spoke-credentials';
import { logAccess } from '$lib/server/identity/access-log';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const c = getCredential(getDb(), locals.consumer.id, 'trakt');
  return json({
    configured: traktConfigured(),
    linked: !!c,
    enabled: c?.enabled ?? false,
    lastSyncAt: c?.lastSyncAt ?? null,
    lastError: c?.lastError ?? null
  });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  if (!traktConfigured()) throw error(503, 'Trakt is not configured on this server');

  const body = await request.json().catch(() => ({}));

  if (body?.action === 'start') {
    const d = await requestDeviceCode();
    // The device code is a short-lived, single-use handle; it is returned to the caller and
    // never persisted server-side.
    return json({ deviceCode: d.deviceCode, userCode: d.userCode, verificationUrl: d.verificationUrl, interval: d.interval });
  }

  if (body?.action === 'poll' && typeof body.deviceCode === 'string') {
    const r = await pollDeviceToken(body.deviceCode);
    if (r.status === 'ok') {
      saveCredential(getDb(), {
        consumerId: locals.consumer.id, spoke: 'trakt',
        secret: r.accessToken, refresh: r.refreshToken, expiresAt: r.expiresAt
      });
      logAccess(getDb(), { consumerId: locals.consumer.id, type: 'trakt_link' });
      return json({ status: 'ok' });
    }
    return json({ status: r.status });
  }

  throw error(400, 'Bad request');
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  deleteCredential(getDb(), locals.consumer.id, 'trakt');
  logAccess(getDb(), { consumerId: locals.consumer.id, type: 'trakt_unlink' });
  return json({ ok: true });
};
```

Both shapes above are verified against the codebase, use them as written:
- `logAccess(db, e)` is exported from `src/lib/server/identity/access-log.ts:31`; its `type` field is
  `AccessType | string`, so the new `'trakt_link'` / `'trakt_unlink'` values need no type change.
- `locals.consumer` is `{ id: number; roleId: number; displayName: string } | null` (`src/app.d.ts:5`).

Add to `src/lib/i18n/en.json`:

```json
"trakt": {
  "title": "Trakt",
  "description": "Sync what you watch to your Trakt account.",
  "connect": "Connect Trakt",
  "disconnect": "Disconnect",
  "codeInstructions": "Go to {url} and enter this code:",
  "waiting": "Waiting for you to approve on trakt.tv…",
  "linked": "Connected",
  "expired": "The code expired. Try again.",
  "notConfigured": "Trakt is not set up on this server."
}
```

Add to `src/lib/i18n/pt-BR.json`:

```json
"trakt": {
  "title": "Trakt",
  "description": "Sincroniza o que você assiste com sua conta do Trakt.",
  "connect": "Conectar Trakt",
  "disconnect": "Desconectar",
  "codeInstructions": "Acesse {url} e digite este código:",
  "waiting": "Esperando você aprovar no trakt.tv…",
  "linked": "Conectado",
  "expired": "O código expirou. Tente de novo.",
  "notConfigured": "O Trakt não está configurado neste servidor."
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/routes/api/app/trakt/server.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/app/trakt src/lib/i18n/en.json src/lib/i18n/pt-BR.json
git commit -m "feat(trakt): consumer link/unlink endpoint via device oauth"
```

---

### Task 7: History gap-filler + poller wiring

**Files:**
- Create: `src/lib/server/consumer/trakt-sync.ts`
- Test: `src/lib/server/consumer/trakt-sync.test.ts`
- Modify: `src/lib/server/agent/events.ts` (add the call inside `tickPoll`)

**Interfaces:**
- Consumes: `watch_plays` (Task 1), `listEnabled`/`recordSuccess`/`recordFailure`/`saveCredential` (Task 2), `refreshToken` (Task 3), `getWatchedIds`/`addToHistory`/`playKey`/`TraktPlay` (Task 5).
- Produces:
  - `selectUnsynced(existing: Set<string>, plays: TraktPlay[]): TraktPlay[]` — pure
  - `pollTraktHistory(db: DB): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/consumer/trakt-sync.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { selectUnsynced, pollTraktHistory } from './trakt-sync';
import { saveCredential, getCredential } from './spoke-credentials';
import type { TraktPlay } from '../integrations/trakt';

const movie: TraktPlay = {
  tmdbId: 278, imdbId: 'tt0111161', mediaType: 'movie', season: null, episode: null, watchedAt: 1000
};
const ep: TraktPlay = {
  tmdbId: 1396, imdbId: null, mediaType: 'tv', season: 2, episode: 5, watchedAt: 2000
};

it('selectUnsynced drops plays Trakt already has, by either id', () => {
  expect(selectUnsynced(new Set(['imdb:tt0111161']), [movie])).toEqual([]);
  expect(selectUnsynced(new Set(['tmdb:278']), [movie])).toEqual([]);
  expect(selectUnsynced(new Set(['tmdb:1396:s2e5']), [ep])).toEqual([]);
  expect(selectUnsynced(new Set(), [movie, ep])).toHaveLength(2);
});

it('selectUnsynced keeps an episode whose show is watched but this episode is not', () => {
  expect(selectUnsynced(new Set(['tmdb:1396:s2e4']), [ep])).toEqual([ep]);
});

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  process.env.PULSE_TRAKT_CLIENT_ID = 'cid';
  process.env.PULSE_TRAKT_CLIENT_SECRET = 'csec';
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (1,?,?)')
    .run('viewer', Date.now());
  db.prepare(
    `INSERT INTO consumer_users(id,role_id,display_name,plex_account_id,status,created_at)
     VALUES (1,1,'Jader','plex-1','active',?)`
  ).run(Date.now());
  db.prepare(
    `INSERT INTO watch_plays(consumer_id,tmdb_id,imdb_id,media_type,season,episode,watched_at,source,source_row)
     VALUES (1,278,'tt0111161','movie',NULL,NULL,1000,'tautulli',1)`
  ).run();
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

it('pushes an unsynced play and records success', async () => {
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', refresh: 'rt', expiresAt: Date.now() + 60_000 });
  await pollTraktHistory(db);

  expect(calls).toContain('POST https://api.trakt.tv/sync/history');
  expect(getCredential(db, 1, 'trakt')?.lastSyncAt).not.toBeNull();
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(0);
});

it('a failing spoke records the failure and does not throw', async () => {
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'at', expiresAt: Date.now() + 60_000 });

  await expect(pollTraktHistory(db)).resolves.toBeUndefined();
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(1);
  expect(getCredential(db, 1, 'trakt')?.lastError).toBeTruthy();
});

it('refreshes an expired token before syncing', async () => {
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    urls.push(String(url));
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'a2', refresh_token: 'r2', expires_in: 7200 }), { status: 200 });
    }
    if (String(url).includes('/sync/watched/')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 201 });
  }) as any);

  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'old', refresh: 'rt', expiresAt: Date.now() - 1000 });
  await pollTraktHistory(db);

  expect(urls.some((u) => u.includes('/oauth/token'))).toBe(true);
  expect(getCredential(db, 1, 'trakt')?.secret).toBe('a2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/lib/server/consumer/trakt-sync.test.ts`
Expected: FAIL — cannot resolve `./trakt-sync`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/server/consumer/trakt-sync.ts`:

```ts
import type { DB } from '../db';
import {
  getWatchedIds, addToHistory, playKey, refreshToken, type TraktPlay
} from '../integrations/trakt';
import { listEnabled, saveCredential, recordSuccess, recordFailure } from './spoke-credentials';

/**
 * History sync is a GAP-FILLER. Trakt's scrobble endpoint already writes history when a play
 * completes, so pushing every stored play would duplicate. Only plays Trakt does not already
 * have are pushed — which is exactly what this is for: plays from while pulse was down, or
 * from before the account was linked.
 */
export function selectUnsynced(existing: Set<string>, plays: TraktPlay[]): TraktPlay[] {
  return plays.filter((p) => !playKey(p).some((k) => existing.has(k)));
}

function playsFor(db: DB, consumerId: number): TraktPlay[] {
  return (db.prepare(
    'SELECT tmdb_id, imdb_id, media_type, season, episode, watched_at FROM watch_plays WHERE consumer_id=? ORDER BY watched_at'
  ).all(consumerId) as any[]).map((r) => ({
    tmdbId: r.tmdb_id ?? null,
    imdbId: r.imdb_id ?? null,
    mediaType: r.media_type === 'tv' ? 'tv' : 'movie',
    season: r.season ?? null,
    episode: r.episode ?? null,
    watchedAt: r.watched_at
  }));
}

/** Push each linked consumer's missing plays to Trakt. Per-consumer isolated: one bad token never stalls the others. */
export async function pollTraktHistory(db: DB): Promise<void> {
  for (const cred of listEnabled(db, 'trakt')) {
    try {
      let accessToken = cred.secret;

      if (cred.expiresAt !== null && cred.expiresAt <= Date.now()) {
        if (!cred.refresh) throw new Error('token expired and no refresh token');
        const t = await refreshToken(cred.refresh);
        saveCredential(db, {
          consumerId: cred.consumerId, spoke: 'trakt',
          secret: t.accessToken, refresh: t.refreshToken, expiresAt: t.expiresAt
        });
        accessToken = t.accessToken;
      }

      const plays = playsFor(db, cred.consumerId);
      if (plays.length === 0) { recordSuccess(db, cred.consumerId, 'trakt'); continue; }

      const [movies, shows] = await Promise.all([
        getWatchedIds(accessToken, 'movies'),
        getWatchedIds(accessToken, 'shows')
      ]);
      const existing = new Set<string>([...movies, ...shows]);

      await addToHistory(accessToken, selectUnsynced(existing, plays));
      recordSuccess(db, cred.consumerId, 'trakt');
    } catch (e) {
      recordFailure(db, cred.consumerId, 'trakt', (e as Error).message);
    }
  }
}
```

Then wire both jobs into the existing tick. In `src/lib/server/agent/events.ts`, inside the function that `tickPoll` calls (the one that already invokes `pollWatchlistAvailability`), add the ingest **before** availability and the Trakt push **after** it:

```ts
import { ingestPlays } from '../consumer/plays-ingest';
import { pollTraktHistory } from '../consumer/trakt-sync';

// ...inside the existing poll body, before pollWatchlistAvailability(db):
const tautulli = listConnections(db).find((c) => c.type === 'tautulli' && c.enabled);
if (tautulli) await ingestPlays(db, tautulli).catch(() => { /* best-effort */ });

// ...after pollWatchlistAvailability(db):
await pollTraktHistory(db).catch(() => { /* best-effort */ });
```

Ordering matters and is a spec requirement: ingest → availability → spoke sync, so a title that just became available is handled in the same cycle rather than the next one.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS — the full suite, including the 5 new tests in this file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/trakt-sync.ts src/lib/server/consumer/trakt-sync.test.ts src/lib/server/agent/events.ts
git commit -m "feat(trakt): history gap-filler wired into the event poller"
```

---

## Manual smoke (owner, after Task 7)

Not a code task — do this before considering Part 1 done.

1. Set `PULSE_TRAKT_CLIENT_ID` / `PULSE_TRAKT_CLIENT_SECRET` in the container env and redeploy
   (`/docker/pulse` on `homelab-docker`, then `docker compose up -d --build`).
2. Link your Trakt account from the consumer app; confirm the code flow completes.
3. Confirm `consumer_users.plex_account_id` is set for your row — **ingest drops plays that match
   no linked consumer, so an unset value means silence, not an error.**
4. Watch something to completion in Plex. Within ~2 minutes confirm a row appears in `watch_plays`,
   and that the play shows up in your Trakt history.
5. Confirm nobody else's plays reached your Trakt account.

### Residual risks to watch during that smoke (from the final whole-branch review)

1. **`plex_account_id` format match.** Provisioning stores `String(data.id)` from `plex.tv/api/v2/user`; ingest matches it against Tautulli's `user_id`. These agree for a full Plex account, but **Plex Home / managed users carry a different id in Tautulli's history**. If a consumer record was created from a managed account, the map silently misses and `ingestPlays` returns 0 forever — the safe direction, but indistinguishable from "nothing to sync" because the per-row catch is silent. First check after one tick: `select count(*) from watch_plays` must be non-zero. If it is zero, compare `consumer_users.plex_account_id` against a `user_id` straight from Tautulli's history.
2. **The first tick is the expensive one.** With an empty cursor it fetches one 200-row page and every distinct title triggers an uncached `get_metadata` — up to 200 sequential HTTP calls inside the poller tick, delaying `pollWatchlistAvailability` and `pruneEvents`. Untested and unbounded in wall-clock. Watch the first tick's duration; every later tick is near-free.
3. **Rewatches never sync, silently.** Trakt's watched set is a boolean per movie/episode, so a second viewing of something already on Trakt is filtered out by `selectUnsynced` forever. Correct for a gap-filler; surprising if you expect a second play on your profile.
4. **The skip window is slightly wider than it looks.** A play finishing *between* the ingest step and the sync step of the same tick gets a `watched_at` earlier than the `lastSyncAt` that tick writes, so `hasNewPlaySince` skips it until any newer play arrives. Never lost — `playsFor` returns the whole history — but a single trailing play at the end of a session can sit unsynced. If "the last episode I watched isn't on Trakt", watch one more thing and re-check before debugging.
5. **Silent failure is the default everywhere.** `ingestPlays` is `.catch(()=>{})`, per-row errors are swallowed, and a disabled credential just vanishes from `listEnabled`. The only visibility is `GET /api/app/trakt` (`linked` / `enabled` / `lastSyncAt` / `lastError`), and **no UI consumes the i18n keys yet**. Curl that endpoint during the smoke and again a day later to confirm `lastSyncAt` advances and `enabled` stays true.

### Parked follow-ups (reviewed, deliberately not fixed in Part 1)

- A credential with no refresh token, or a `400 invalid_grant` on the refresh path, records a note but never disables — only 401/403 count toward `MAX_FAILS`. Both need a hand-edited row or an undocumented Trakt behaviour to reach.
- `last_error` is now overloaded three ways (hard failure, transient note, informational not-found count). Whoever builds the UI should add a `last_note` column or a severity prefix, or an informational note will render as a fault.
- `watch_plays.source_row` is nullable inside its UNIQUE constraint; SQLite does not dedupe NULLs. Harmless while Tautulli is the only source, but tighten it if a second source is added — it needs a real ALTER path, which `migrate()` does not have.
- The ingest cursor is `MAX(source_row)` of *inserted* rows, so on a busy multi-user server it can stall and re-scan up to 10 pages per tick. It self-heals as soon as the consumer watches something; the proper home is the already-created, currently-unused `sync_state` table holding the max row_id *seen*.

## Not in this plan

Part 1 covers spec stages 1–2 (Tautulli ingest, Trakt history gap-filler) only.

**Stage 3 (Trakt live scrobbling) is deliberately deferred to Part 2**, together with stages 4–7
(Stremio watchlist, Trakt watchlist, Stremio progress, Trakt ratings). Scrobbling is what makes the
gap-filler's dedupe rule load-bearing, so it is safer to add once the gap-filler is running against
a real account and its behavior is observed. The two open verification questions in the spec
(Stremio `authKey` acquisition, Seerr reverse imdb→tmdb lookup) block those stages, not this one.
