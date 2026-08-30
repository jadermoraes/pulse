# Household Stremio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Stremio Library sync from a per-viewer integration to a single household one, configured by the admin in dash, with an explicit list of which pulse consumers share it.

**Architecture:** The credential moves from `spoke_credentials` (keyed by consumer) to a single row in the `connections` table (`type='stremio'`), whose `options` blob carries the account email, the participant ids, and the sync health. Sync provenance moves from `sync_state` to a new consumer-free `household_sync_state` table. `stremio-sync.ts` is rewritten to load one *union* of the participants' watchlists and in-flight requests, and to fan inbound imports and inbound removals out to every participant inside a transaction. The pure reconciler, the Stremio API client and Cinemeta are untouched. The consumer-facing Stremio panel and its endpoint are deleted; Trakt's stay.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, better-sqlite3, zod 4, vitest, Playwright, svelte-i18n.

**Spec:** `docs/superpowers/specs/2026-08-29-household-stremio-design.md`

## Global Constraints

- **Never store, log, echo or persist the Stremio password.** It is exchanged for an authKey in one call and discarded. The authKey is encrypted by the `connections` layer and never logged.
- **`src/lib/server/consumer/stremio-reconcile.ts` must not be modified.** It takes two lists and does not care where they came from. Its test file must not be weakened either.
- **`migrate()` in `src/lib/server/db.ts` has no `ALTER` path and is uncaught in `getDb()`** — a throwing statement stops the app booting. New schema is `CREATE TABLE IF NOT EXISTS` only. Never `ALTER` an existing table.
- **`foreign_keys = ON`.** Any row referencing `consumer_users(id)` must reference a real consumer. Test fixtures must seed `roles` before `consumer_users`; `migrate()` auto-seeds an Admin role at **id = 1**, so fixtures use **id = 2**.
- **Tests must never open the real `pulse.sqlite`.** Use `openDb(':memory:')` + `migrate(db)`.
- **`rateLimit(key, n, windowMs)` RETURNS `{ ok, retryAfter }`; it does not throw.** An unchecked call is a silent no-op.
- **Every user-visible string goes through `svelte-i18n`** and must exist in BOTH `src/lib/i18n/en.json` and `src/lib/i18n/pt-BR.json`. `dictionaries.test.ts` fails the build on any key present in one and absent in the other, and on any empty string value.
- **pt-BR copy is direct, never corporate-cutesy.** Plain wording ("Contas vinculadas"), no translated idioms.
- **No assistant attribution in commit messages.** No `Co-Authored-By`, no `Claude-Session`, no "Generated with". Plain messages only.
- Full suite: `npm test` (vitest). Type check: `npm run check`. E2E: `npm run e2e`.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/server/db.ts` | **Modify** — add the `household_sync_state` table. |
| `src/lib/server/consumer/household-stremio.ts` | **Create** — the household connection: read, link, participants, unlink, and the success/note/failure health trio. |
| `src/lib/server/consumer/household-stremio.test.ts` | **Create** — tests for the above. |
| `src/lib/server/consumer/stremio-sync.ts` | **Modify** — household-scoped `loadPulseItems`, fan-out `applyPull`, connection-driven `pollStremioSync`. |
| `src/lib/server/consumer/stremio-sync.test.ts` | **Modify** — rewritten fixtures + new household tests. |
| `src/lib/server/consumer/spoke-credentials.ts` | **Modify** — narrow `SpokeId` to `'trakt'`. |
| `src/routes/api/stremio/+server.ts` | **Create** — admin GET/POST/PATCH/DELETE. |
| `src/routes/api/stremio/server.test.ts` | **Create** — tests for the above. |
| `src/routes/api/stremio/test/+server.ts` | **Create** — admin POST that probes the live Library and reports the item count. |
| `src/routes/api/app/stremio/` | **Delete** — the per-viewer endpoint and its test. |
| `src/routes/settings/+page.svelte` | **Modify** — the household panel in the Connections tab. |
| `src/routes/app/account/+page.svelte` | **Modify** — remove the consumer Stremio block. |
| `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json` | **Modify** — move `stremio.*` to the admin surface, add the new keys. |
| `e2e/household-stremio.spec.ts` | **Create** — the admin panel drives link → participants → unlink against mocked endpoints. |

---

### Task 1: `household_sync_state` table and the household connection module

**Files:**
- Modify: `src/lib/server/db.ts` (insert after the `sync_state` table, around line 254)
- Create: `src/lib/server/consumer/household-stremio.ts`
- Test: `src/lib/server/consumer/household-stremio.test.ts`

**Interfaces:**
- Consumes: `Connection`, `createConnection`, `listConnections`, `updateConnection`, `deleteConnection` from `../connections`; `MAX_FAILS` from `./spoke-credentials`.
- Produces, for Tasks 2–3:
  - `STREMIO_TYPE = 'stremio'`
  - `getStremioConnection(db: DB): Connection | null`
  - `participantIds(db: DB, conn: Connection): number[]`
  - `readHousehold(db: DB): StremioHousehold | null` where `StremioHousehold = { connection: Connection; email: string; participantIds: number[]; lastSyncAt: number | null; lastError: string | null; failCount: number }`
  - `saveStremioConnection(db: DB, v: { email: string; authKey: string }): void`
  - `setParticipants(db: DB, ids: number[]): void`
  - `unlinkStremio(db: DB): void`
  - `recordHouseholdSuccess(db: DB): void`
  - `recordHouseholdNote(db: DB, message: string): void`
  - `recordHouseholdFailure(db: DB, message: string): void`

- [ ] **Step 1: Add the table to `migrate()`**

In `src/lib/server/db.ts`, immediately after the `CREATE TABLE IF NOT EXISTS sync_state (...);` statement, add:

```sql
    -- Stremio is a HOUSEHOLD spoke: one account on one TV, shared by several pulse consumers.
    -- Its provenance therefore has no consumer to key on. It cannot live in `sync_state`:
    -- that table's consumer_id REFERENCES consumer_users(id) with foreign_keys=ON, so a
    -- reserved id like 0 throws; and adding a nullable column would need an ALTER, which
    -- migrate() deliberately does not do. A separate table is the only shape that works on
    -- both a fresh and an existing database.
    CREATE TABLE IF NOT EXISTS household_sync_state (
      spoke        TEXT NOT NULL,
      entity       TEXT NOT NULL,
      tmdb_id      INTEGER NOT NULL,
      media_type   TEXT NOT NULL,
      synced_at    INTEGER,
      dropped_at   INTEGER,
      PRIMARY KEY (spoke, entity, tmdb_id, media_type)
    );
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/server/consumer/household-stremio.test.ts`:

```ts
import { it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  getStremioConnection, participantIds, readHousehold, saveStremioConnection,
  setParticipants, unlinkStremio, recordHouseholdSuccess, recordHouseholdNote,
  recordHouseholdFailure
} from './household-stremio';
import { MAX_FAILS } from './spoke-credentials';

let db: DB;
let a: number;
let b: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const mk = (n: string) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,?,'active',?)"
  ).run(n, Date.now()).lastInsertRowid);
  a = mk('Jader'); b = mk('Jessica');
});

it('household_sync_state accepts a row with no consumer_id', () => {
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',278,'movie',?,NULL)`
  ).run(Date.now());
  const r = db.prepare("SELECT * FROM household_sync_state WHERE tmdb_id=278").get() as any;
  expect(r.spoke).toBe('stremio');
  expect(r.dropped_at).toBeNull();
});

it('is unlinked until saveStremioConnection runs', () => {
  expect(getStremioConnection(db)).toBeNull();
  expect(readHousehold(db)).toBeNull();
});

it('stores the authKey and email, never a password, and starts with no participants', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-1' });
  const h = readHousehold(db)!;
  expect(h.email).toBe('fixture-account@example.invalid');
  expect(h.connection.secret).toBe('ak-1');
  expect(h.participantIds).toEqual([]);
  expect(h.connection.enabled).toBe(true);
  // The row must round-trip through config export/import, which rejects an empty baseUrl.
  expect(h.connection.baseUrl).not.toBe('');
  // The whole options blob is inspected: a password must not have been smuggled into it.
  expect(JSON.stringify(h.connection.options)).not.toContain('password');
});

it('a relink keeps the existing participant list', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-1' });
  setParticipants(db, [a, b]);
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-2' });
  const h = readHousehold(db)!;
  expect(h.connection.secret).toBe('ak-2');
  expect(h.participantIds).toEqual([a, b]);
});

it('a relink re-enables a connection that failure had disabled, and clears its error', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-1' });
  for (let i = 0; i < MAX_FAILS; i++) recordHouseholdFailure(db, 'Invalid auth');
  expect(getStremioConnection(db)!.enabled).toBe(false);
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-2' });
  const h = readHousehold(db)!;
  expect(h.connection.enabled).toBe(true);
  expect(h.failCount).toBe(0);
  expect(h.lastError).toBeNull();
});

it('skips a participant id whose consumer has since been deleted', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  setParticipants(db, [a, b, 9999]);
  db.prepare('DELETE FROM consumer_users WHERE id=?').run(b);
  // 9999 never existed; b existed and is gone. Both are dropped, and nothing throws.
  expect(participantIds(db, getStremioConnection(db)!)).toEqual([a]);
});

it('ignores a participantIds blob that is not an array of integers', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  const conn = getStremioConnection(db)!;
  expect(participantIds(db, { ...conn, options: { participantIds: 'all' } })).toEqual([]);
  expect(participantIds(db, { ...conn, options: {} })).toEqual([]);
  expect(participantIds(db, { ...conn, options: { participantIds: [a, 'x', 1.5] } })).toEqual([a]);
});

it('recordHouseholdSuccess stamps lastSyncAt and clears the error and fail count', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  recordHouseholdFailure(db, 'boom');
  recordHouseholdSuccess(db);
  const h = readHousehold(db)!;
  expect(h.lastSyncAt).not.toBeNull();
  expect(h.lastError).toBeNull();
  expect(h.failCount).toBe(0);
});

it('recordHouseholdNote leaves a message without counting toward MAX_FAILS', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  for (let i = 0; i < MAX_FAILS + 3; i++) recordHouseholdNote(db, 'Stremio HTTP 503');
  const h = readHousehold(db)!;
  expect(h.lastError).toBe('Stremio HTTP 503');
  expect(h.failCount).toBe(0);
  expect(h.connection.enabled).toBe(true);
});

it('recordHouseholdFailure disables only on the MAX_FAILS-th failure', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  for (let i = 0; i < MAX_FAILS - 1; i++) recordHouseholdFailure(db, 'Invalid auth');
  expect(getStremioConnection(db)!.enabled).toBe(true);
  expect(readHousehold(db)!.failCount).toBe(MAX_FAILS - 1);
  recordHouseholdFailure(db, 'Invalid auth');
  expect(getStremioConnection(db)!.enabled).toBe(false);
});

it('health writes preserve the authKey rather than blanking it', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak-secret' });
  setParticipants(db, [a]);
  recordHouseholdNote(db, 'note');
  recordHouseholdSuccess(db);
  const h = readHousehold(db)!;
  expect(h.connection.secret).toBe('ak-secret');
  expect(h.email).toBe('fixture-account@example.invalid');
  expect(h.participantIds).toEqual([a]);
});

it('the health helpers are no-ops when nothing is linked', () => {
  expect(() => {
    recordHouseholdSuccess(db); recordHouseholdNote(db, 'x'); recordHouseholdFailure(db, 'y');
    setParticipants(db, [a]); unlinkStremio(db);
  }).not.toThrow();
  expect(getStremioConnection(db)).toBeNull();
});

it('unlinkStremio removes the row entirely', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  unlinkStremio(db);
  expect(getStremioConnection(db)).toBeNull();
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/lib/server/consumer/household-stremio.test.ts`
Expected: FAIL — `Failed to resolve import "./household-stremio"`.

- [ ] **Step 4: Write `household-stremio.ts`**

Create `src/lib/server/consumer/household-stremio.ts`:

```ts
import type { DB } from '../db';
import type { Connection } from '../connections';
import { createConnection, listConnections, updateConnection, deleteConnection } from '../connections';
import { MAX_FAILS } from './spoke-credentials';

/**
 * Stremio is a HOUSEHOLD spoke, not a per-viewer one: one account, on one TV, shared by the
 * consumers an admin nominates. Its credential therefore lives where the other household-wide
 * credentials live — the `connections` table — and not in `spoke_credentials`, which is keyed by
 * consumer and stays for Trakt.
 */
export const STREMIO_TYPE = 'stremio';

/**
 * `config.ts`'s import validator rejects a connection whose baseUrl is empty, so an exported
 * config would fail to re-import if this were ''. It is also simply true: this is the API the
 * integration talks to.
 */
const STREMIO_BASE_URL = 'https://api.strem.io';

export interface StremioHousehold {
  connection: Connection;
  email: string;
  participantIds: number[];
  lastSyncAt: number | null;
  lastError: string | null;
  failCount: number;
}

/** The one household row, enabled or not — the admin panel must be able to show a disabled link. */
export function getStremioConnection(db: DB): Connection | null {
  return listConnections(db).find((c) => c.type === STREMIO_TYPE) ?? null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The participant list lives in a JSON blob with no foreign key, so an id whose consumer has
 * since been deleted is data we will see, not data we can prevent. Resolve against
 * `consumer_users` on every read and drop what no longer exists — silently, because a stale id
 * is an ordinary consequence of deleting a user, not an error the sync should stall on.
 */
export function participantIds(db: DB, conn: Connection): number[] {
  const raw = conn.options.participantIds;
  const ids = Array.isArray(raw) ? raw.filter((v): v is number => Number.isInteger(v)) : [];
  if (ids.length === 0) return [];
  const live = new Set(
    (db.prepare(`SELECT id FROM consumer_users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number }>).map((r) => r.id)
  );
  return ids.filter((id) => live.has(id));
}

export function readHousehold(db: DB): StremioHousehold | null {
  const connection = getStremioConnection(db);
  if (!connection) return null;
  return {
    connection,
    email: str(connection.options.email) ?? '',
    participantIds: participantIds(db, connection),
    lastSyncAt: num(connection.options.lastSyncAt),
    lastError: str(connection.options.lastError),
    failCount: num(connection.options.failCount) ?? 0
  };
}

/**
 * Link, or relink after a key went stale. A relink keeps the participant list — the admin picked
 * those people and re-entering a password is not a request to forget them — and resets the health
 * counters, so a connection that MAX_FAILS had disabled comes back enabled.
 */
export function saveStremioConnection(db: DB, v: { email: string; authKey: string }): void {
  const existing = getStremioConnection(db);
  const options = {
    email: v.email,
    participantIds: existing ? participantIds(db, existing) : [],
    lastSyncAt: null,
    lastError: null,
    failCount: 0
  };
  if (existing) {
    updateConnection(db, existing.id, { secret: v.authKey, options, enabled: true });
  } else {
    createConnection(db, {
      type: STREMIO_TYPE, name: 'Stremio', baseUrl: STREMIO_BASE_URL,
      secret: v.authKey, options
    });
  }
}

export function setParticipants(db: DB, ids: number[]): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  updateConnection(db, conn.id, { options: { ...conn.options, participantIds: ids } });
}

export function unlinkStremio(db: DB): void {
  const conn = getStremioConnection(db);
  if (conn) deleteConnection(db, conn.id);
}

/** Mirrors spoke-credentials' recordSuccess: the credential worked this cycle. */
export function recordHouseholdSuccess(db: DB): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  updateConnection(db, conn.id, {
    options: { ...conn.options, failCount: 0, lastError: null, lastSyncAt: Date.now() }
  });
}

/**
 * Mirrors spoke-credentials' recordNote: leave a message WITHOUT counting toward MAX_FAILS.
 * `failCount` never decays, so counting every thrown error would let a ten-minute Stremio outage
 * (five poller ticks) permanently disable a working link. Reserve `recordHouseholdFailure` for
 * failures that mean the authKey itself is dead.
 */
export function recordHouseholdNote(db: DB, message: string): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  updateConnection(db, conn.id, {
    options: { ...conn.options, lastError: message.slice(0, 500) }
  });
}

/** Count a failure toward MAX_FAILS, disabling the connection once it is reached. */
export function recordHouseholdFailure(db: DB, message: string): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  const failCount = (num(conn.options.failCount) ?? 0) + 1;
  updateConnection(db, conn.id, {
    options: { ...conn.options, failCount, lastError: message.slice(0, 500) },
    enabled: failCount < MAX_FAILS ? conn.enabled : false
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/server/consumer/household-stremio.test.ts src/lib/server/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/db.ts src/lib/server/consumer/household-stremio.ts src/lib/server/consumer/household-stremio.test.ts
git commit -m "feat: household stremio connection and household_sync_state table"
```

---

### Task 2: Rewrite `stremio-sync.ts` to household scope

**Files:**
- Modify: `src/lib/server/consumer/stremio-sync.ts`
- Test: `src/lib/server/consumer/stremio-sync.test.ts` (rewrite the fixtures and add household cases)
- Do NOT touch: `src/lib/server/consumer/stremio-reconcile.ts`

**Interfaces:**
- Consumes from Task 1: `getStremioConnection`, `participantIds`, `recordHouseholdSuccess`, `recordHouseholdNote`, `recordHouseholdFailure`, and the `household_sync_state` table.
- Produces, changed signatures:
  - `loadPulseItems(db: DB, participants: number[], seerr: Connection | null): Promise<PulseItem[]>` — was `(db, consumerId, seerr)`
  - `applyPull(db: DB, participants: number[], plan: ReconcileResult): Promise<number>` — was `(db, consumerId, plan)`
  - `pollStremioSync(db: DB): Promise<void>` — unchanged signature, different source of credentials
  - `buildLibraryItem` and `MAX_IMPORTS_PER_CYCLE` are unchanged and stay exported.

**Semantics ruling this task implements — read before writing code.** The household list is a plain **union**. Inbound removals (someone deleted a title on the TV) fan out to every participant, because otherwise the participants who still hold the row push the title straight back and it reappears on the TV. Outbound removals do NOT fan out: a participant removing a title in pulse merely stops contributing it, and it leaves the TV once the last contributor drops it. Deleting other people's watchlist rows on one person's say-so would destroy data pulse was never asked to touch, and the union is already stable without it.

- [ ] **Step 1: Write the failing household tests**

In `src/lib/server/consumer/stremio-sync.test.ts`, replace the fixture block at the top (currently lines 1–25) with:

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { buildLibraryItem, loadPulseItems, pollStremioSync, MAX_IMPORTS_PER_CYCLE } from './stremio-sync';
import { saveStremioConnection, setParticipants, readHousehold, getStremioConnection } from './household-stremio';
import { addWatchlist, listWatchlist } from './watchlist';
import { createConnection, getConnection } from '../connections';
import { resolveImdbMeta } from '../integrations/cinemeta';
import type { PulseItem } from './stremio-reconcile';

const want: PulseItem = {
  tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161',
  title: 'Shawshank', onServer: false, droppedAt: null
};

let db: DB;
let consumerId: number;
let otherId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  const mk = (n: string) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,?,'active',?)"
  ).run(n, Date.now()).lastInsertRowid);
  consumerId = mk('Jader');
  otherId = mk('Jessica');
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

/** Link the household account with `ids` as its participants. Replaces the old saveCredential. */
function link(ids: number[], authKey = 'ak'): void {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey });
  setParticipants(db, ids);
}

/** Seed the Cinemeta cache so tmdb <-> imdb resolution needs no network. */
function seedMeta(imdb: string, tmdb: number, type: 'movie' | 'series', name: string): void {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES (?,?,?,?,NULL,1,?)`
  ).run(imdb, type, tmdb, name, Date.now());
}

/** A fetch stub over the two Stremio endpoints. Returns the captured datastorePut bodies. */
function stubStremio(library: any[]): { puts: any[]; urls: string[] } {
  const puts: any[] = [];
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: library }), { status: 200 });
    if (u.endsWith('/datastorePut')) {
      puts.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  return { puts, urls };
}
```

Then update every existing test in the file so that:
- `saveCredential(db, { consumerId, spoke: 'stremio', secret: 'ak' })` becomes `link([consumerId])`;
- `getCredential(db, consumerId, 'stremio')?.lastSyncAt` becomes `readHousehold(db)!.lastSyncAt`, and `?.lastError` becomes `readHousehold(db)!.lastError`, and `?.enabled` becomes `getStremioConnection(db)!.enabled`;
- `loadPulseItems(db, consumerId, seerr)` becomes `loadPulseItems(db, [consumerId], seerr)`;
- every `INSERT INTO sync_state (...) VALUES (?, 'stremio', ...)` fixture becomes an insert into `household_sync_state` with the `consumer_id` column and its bound parameter dropped, and every `SELECT ... FROM sync_state WHERE consumer_id=? AND spoke='stremio'` assertion likewise;
- the `saveCredential`/`getCredential`/`recordFailure` imports from `./spoke-credentials` are dropped.

Every existing assertion must keep asserting the same behaviour. Do not delete a test to make it pass; if one no longer type-checks, port it.

Then append these new tests:

```ts
it('loadPulseItems unions the participants watchlists, once per title', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  seedMeta('tt0068646', 238, 'movie', 'Godfather');
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: otherId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: otherId, tmdbId: 238, mediaType: 'movie', title: 'Godfather', onServer: false, notifyOnAvailable: false });

  const items = await loadPulseItems(db, [consumerId, otherId], null);
  expect(items.map((i) => i.tmdbId).sort()).toEqual([238, 278]);
});

it('loadPulseItems excludes a non-participant entirely', async () => {
  seedMeta('tt0068646', 238, 'movie', 'Godfather');
  addWatchlist(db, { consumerId: otherId, tmdbId: 238, mediaType: 'movie', title: 'Godfather', onServer: false, notifyOnAvailable: false });
  const items = await loadPulseItems(db, [consumerId], null);
  expect(items).toEqual([]);
});

it('a title stays wanted while ANY participant still waits for it', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  // One participant has it marked landed; the other is still waiting.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: otherId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  const items = await loadPulseItems(db, [consumerId, otherId], null);
  expect(items).toHaveLength(1);
  expect(items[0].onServer).toBe(false);
});

it('a title is landed only once every participant agrees', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: otherId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: false });
  const items = await loadPulseItems(db, [consumerId, otherId], null);
  expect(items[0].onServer).toBe(true);
});

it('an import lands on EVERY participant and on nobody else', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  const outsider = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Guest','active',?)"
  ).run(Date.now()).lastInsertRowid);
  link([consumerId, otherId]);
  stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }]);

  await pollStremioSync(db);

  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
  expect(listWatchlist(db, otherId).map((r) => r.tmdbId)).toEqual([278]);
  expect(listWatchlist(db, outsider)).toEqual([]);
  // and it is recorded once, at household scope
  const n = db.prepare("SELECT COUNT(*) c FROM household_sync_state WHERE tmdb_id=278").get() as any;
  expect(n.c).toBe(1);
});

it('an import never arms a notification for anyone', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }]);
  await pollStremioSync(db);
  for (const id of [consumerId, otherId]) {
    expect(listWatchlist(db, id)[0].notifyOnAvailable).toBe(false);
  }
});

it('a removal on the TV fans out to every participant', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  for (const id of [consumerId, otherId]) {
    addWatchlist(db, { consumerId: id, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  }
  link([consumerId, otherId]);
  // Tombstoned in Stremio, and pulse never dropped it (no household_sync_state row) -> a real
  // viewer removal.
  stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: true }]);

  await pollStremioSync(db);

  expect(listWatchlist(db, consumerId)).toEqual([]);
  expect(listWatchlist(db, otherId)).toEqual([]);
});

it('one participant removing a title in pulse leaves the others alone', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  addWatchlist(db, { consumerId: otherId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  link([consumerId, otherId]);
  // Jader never had it (or removed it). Jessica still does, so it stays on the shared list and
  // is pushed, NOT removed.
  const { puts } = stubStremio([]);

  await pollStremioSync(db);

  expect(listWatchlist(db, otherId)).toHaveLength(1);
  expect(puts).toHaveLength(1);
  expect(puts[0].changes[0]._id).toBe('tt0111161');
  expect(puts[0].changes[0].removed).toBe(false);
});

it('does nothing at all when linked but no participants are selected', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([]);
  const { urls } = stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }]);

  await pollStremioSync(db);

  // No network at all: an empty pulse list would read the whole TV Library as importable and
  // write household_sync_state rows for titles landing on nobody.
  expect(urls).toEqual([]);
  const n = db.prepare('SELECT COUNT(*) c FROM household_sync_state').get() as any;
  expect(n.c).toBe(0);
  expect(readHousehold(db)!.lastError).toContain('participant');
});

it('does nothing when the connection is disabled', async () => {
  link([consumerId]);
  const conn = getStremioConnection(db)!;
  db.prepare('UPDATE connections SET enabled=0 WHERE id=?').run(conn.id);
  const { urls } = stubStremio([]);
  await pollStremioSync(db);
  expect(urls).toEqual([]);
});

it('does nothing when nothing is linked', async () => {
  const { urls } = stubStremio([]);
  await pollStremioSync(db);
  expect(urls).toEqual([]);
});

it('a 401 from Stremio counts toward MAX_FAILS; a 503 does not', async () => {
  link([consumerId]);
  global.fetch = (vi.fn(async () => new Response('nope', { status: 503 })) as any);
  await pollStremioSync(db);
  expect(readHousehold(db)!.failCount).toBe(0);
  expect(readHousehold(db)!.lastError).toContain('503');

  global.fetch = (vi.fn(async () => new Response('nope', { status: 401 })) as any);
  await pollStremioSync(db);
  expect(readHousehold(db)!.failCount).toBe(1);
});

it('a partial import fan-out is rolled back rather than half-applied', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }]);
  // Deleting the second participant mid-flight is not reproducible here, so drive the failure
  // through the constraint instead: a NOT NULL violation inside the fan-out must leave NO
  // watchlist row and NO household_sync_state row behind.
  const orig = db.prepare.bind(db);
  let calls = 0;
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('INSERT INTO consumer_watchlist') && ++calls === 2) {
      throw new Error('injected failure on the second participant');
    }
    return orig(sql);
  }) as any);

  await pollStremioSync(db);

  vi.restoreAllMocks();
  expect(listWatchlist(db, consumerId)).toEqual([]);
  expect(listWatchlist(db, otherId)).toEqual([]);
  const n = db.prepare('SELECT COUNT(*) c FROM household_sync_state').get() as any;
  expect(n.c).toBe(0);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/server/consumer/stremio-sync.test.ts`
Expected: FAIL — `loadPulseItems` still takes a `consumerId`, `pollStremioSync` still reads `spoke_credentials`, and `household_sync_state` is not written.

- [ ] **Step 3: Rewrite the module**

In `src/lib/server/consumer/stremio-sync.ts`:

Replace the `spoke-credentials` import with the household one:

```ts
import {
  getStremioConnection, participantIds,
  recordHouseholdSuccess, recordHouseholdNote, recordHouseholdFailure
} from './household-stremio';
```

Leave `imdbForTmdb`, `inFlightRequests`, `OWNED_KEYS`, `blankValue`, `buildLibraryItem` and `MAX_IMPORTS_PER_CYCLE` exactly as they are, comments included.

Replace `loadPulseItems` with:

```ts
function dedupeKey(tmdbId: number, mediaType: string): string {
  return `${tmdbId}:${mediaType === 'tv' ? 'tv' : 'movie'}`;
}

/**
 * The household list is the UNION of every participant's watchlist and in-flight requests,
 * one entry per (tmdbId, mediaType) no matter how many people contributed it. From Stremio's
 * side that is one list, which is what a shared TV should show.
 *
 * Within a participant the existing rule holds: a watchlist row wins over a request row for the
 * same title (it carries on_server). Across participants, `onServer` is AND-ed. `onServer` drives
 * "drop it from the Library once it has landed", so a title one person is still waiting on must
 * stay in the list; taking the first contributor's flag, or OR-ing, would yank a title off the
 * shared TV while somebody was still queued for it.
 *
 * The participant order decides which contributor's title text is displayed. Callers pass ids in
 * a stable order so a poll cycle is deterministic.
 */
export async function loadPulseItems(
  db: DB, participants: number[], seerr: Connection | null
): Promise<PulseItem[]> {
  const merged = new Map<string, { tmdbId: number; mediaType: 'movie' | 'tv'; title: string; onServer: boolean }>();

  for (const consumerId of participants) {
    const watchlist = listWatchlist(db, consumerId);
    const seen = new Set(watchlist.map((r) => dedupeKey(r.tmdbId, r.mediaType)));
    const rows: Array<{ tmdbId: number; mediaType: string; title: string; onServer: boolean }> = [
      ...watchlist.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title, onServer: r.onServer })),
      ...inFlightRequests(db, consumerId).filter((q) => !seen.has(dedupeKey(q.tmdbId, q.mediaType)))
    ];
    for (const r of rows) {
      const mediaType = r.mediaType === 'tv' ? 'tv' : 'movie';
      const k = dedupeKey(r.tmdbId, mediaType);
      const prev = merged.get(k);
      merged.set(k, prev
        ? { ...prev, onServer: prev.onServer && r.onServer }
        : { tmdbId: r.tmdbId, mediaType, title: r.title, onServer: r.onServer });
    }
  }

  const out: PulseItem[] = [];
  for (const r of merged.values()) {
    const imdbId = await imdbForTmdb(db, seerr, r.tmdbId, r.mediaType);
    const st = db.prepare(
      `SELECT dropped_at FROM household_sync_state
        WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
    ).get(r.tmdbId, r.mediaType) as any;
    out.push({
      tmdbId: r.tmdbId, mediaType: r.mediaType, imdbId, title: r.title,
      onServer: r.onServer, droppedAt: st?.dropped_at ?? null
    });
  }
  return out;
}
```

Replace `markSynced` with:

```ts
function markSynced(db: DB, p: PulseItem, dropped: number | null): void {
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',?,?,?,?)
     ON CONFLICT(spoke,entity,tmdb_id,media_type) DO UPDATE SET
       synced_at=excluded.synced_at, dropped_at=excluded.dropped_at`
  ).run(p.tmdbId, p.mediaType, Date.now(), dropped);
}
```

Replace `applyPull` with (keeping every existing comment on the import loop, and adding the fan-out rationale):

```ts
export async function applyPull(db: DB, participants: number[], plan: ReconcileResult): Promise<number> {
  let skipped = 0;
  for (const s of plan.importItems.slice(0, MAX_IMPORTS_PER_CYCLE)) {
    try {
      const type = s.type === 'series' ? 'series' : 'movie';
      const meta = await resolveImdbMeta(db, s.imdbId, type);
      if (!meta || meta.tmdbId === null) continue; // unresolvable: not an error
      const tmdbId = meta.tmdbId;
      const name = meta.name;
      const mediaType = type === 'series' ? 'tv' : 'movie';
      // The fan-out and its provenance row commit together or not at all. A half-applied import
      // is the worst outcome available: the household_sync_state row makes the title "already
      // known", so the next cycle will not retry it, while some participants never received it.
      // The Cinemeta fetch is deliberately outside the transaction — better-sqlite3 transactions
      // are synchronous and must not await.
      db.transaction(() => {
        for (const consumerId of participants) {
          // importWatchlist, NOT addWatchlist: an import must never clobber a row pulse already
          // owns (its on_server flag in particular), and never arms a notify the viewer didn't
          // ask for. On a first link this loop can see a hundred titles; notify=1 would fire a
          // push AND a Telegram DM AND a Jellyfin favourite for every one of them, per person.
          importWatchlist(db, { consumerId, tmdbId, mediaType, title: name, onServer: false });
        }
        db.prepare(
          `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
           VALUES ('stremio','watchlist',?,?,?,NULL)
           ON CONFLICT(spoke,entity,tmdb_id,media_type) DO UPDATE SET synced_at=excluded.synced_at`
        ).run(tmdbId, mediaType, Date.now());
      })();
    } catch {
      // one bad title never blocks the rest — matches plays-ingest's contract. A Cinemeta 5xx
      // on this id must not also stall every OTHER import and every pending delete this cycle.
      skipped++;
    }
  }

  for (const p of plan.deleteItems) {
    // Inbound removals DO fan out. The reconciler has already excluded removals pulse itself
    // performed, so this is a person deleting the title on the TV. Removing it from only some
    // participants would leave the others still contributing it to the union — pulse would push
    // it straight back and it would reappear on the TV, which is the ping-pong the reconciler's
    // dropped_at guard exists to prevent, re-introduced one level up.
    //
    // The OUTBOUND direction is deliberately NOT symmetric: a participant removing a title in
    // pulse only stops contributing it, and it leaves the TV when the last contributor drops it.
    db.transaction(() => {
      for (const consumerId of participants) removeWatchlist(db, consumerId, p.tmdbId, p.mediaType);
      db.prepare(
        `DELETE FROM household_sync_state
          WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=? AND media_type=?`
      ).run(p.tmdbId, p.mediaType);
    })();
  }

  return skipped;
}
```

Replace `pollStremioSync` with:

```ts
/** Household-scoped: one Stremio account, one authKey, shared by the nominated consumers. */
export async function pollStremioSync(db: DB): Promise<void> {
  const conn = getStremioConnection(db);
  if (!conn || !conn.enabled || !conn.secret) return;

  // Sorted so the union's title choice and the push order are stable across cycles.
  const participants = participantIds(db, conn).slice().sort((a, b) => a - b);
  if (participants.length === 0) {
    // Bail BEFORE any network call. With an empty pulse list the reconciler reads the entire TV
    // Library as importable, and applyPull would stamp household_sync_state rows for titles that
    // landed on nobody — poisoning the "already known" check for whoever is added later.
    recordHouseholdNote(db, 'No pulse users are selected as participants, so nothing is being synced.');
    return;
  }

  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;

  try {
    const library = await datastoreGet(conn.secret);
    const stremioItems: StremioItem[] = library.map((i) => ({
      imdbId: i._id, type: i.type, removed: i.removed
    }));
    const pulseItems = await loadPulseItems(db, participants, seerr);
    const plan = reconcile(pulseItems, stremioItems);

    const byId = new Map(library.map((i) => [i._id, i]));
    const template = library[0] ?? null;
    const changes: StremioLibraryItem[] = [];
    // sync_state writes are staged here and applied only once `datastorePut` below has
    // actually succeeded. Writing them eagerly means a transient datastorePut failure — a 5xx,
    // a timeout — still commits e.g. `dropped_at = NULL` for a re-pushed, still-tombstoned item;
    // the NEXT cycle then reads that premature clear and the reconciler routes the item to
    // `deleteItems`, destroying watchlist rows over nothing more than a network blip.
    const syncUpdates: Array<{ p: PulseItem; dropped: number | null }> = [];

    for (const p of plan.push) {
      // Guarded per item, in the same spirit as the import loop. `imdbForTmdb` only ever UPDATEs
      // a Cinemeta-created cache row, so a Seerr-sourced imdb id has no row and goes to the
      // network here — and `fetchCinemetaMeta` throws on any non-404 non-2xx. Unguarded, that one
      // id's 5xx escapes past datastorePut, past the sync_state drain and past applyPull.
      let meta: { name: string; poster: string | null } | null = null;
      try {
        meta = await resolveImdbMeta(db, p.imdbId!, stremioType(p.mediaType));
      } catch {
        meta = null;
      }
      // Prefer the item's OWN current shape when Stremio already has it (e.g. reviving a title
      // pulse tombstoned earlier): that item's `state` is the household's real progress, not a
      // borrowed shape, and buildLibraryItem must not zero it.
      changes.push(buildLibraryItem(p, byId.get(p.imdbId!) ?? template, meta));
      syncUpdates.push({ p, dropped: null });
    }

    for (const p of plan.remove) {
      const existing = byId.get(p.imdbId!);
      if (!existing) continue;
      // read-modify-write: only `removed` and `_mtime` are ours. Watch progress lives in `state`
      // and is synced across the household's devices — clobbering it would erase it.
      changes.push({ ...existing, removed: true, _mtime: new Date().toISOString() });
      syncUpdates.push({ p, dropped: Date.now() });
    }

    for (const p of plan.clearDropped) syncUpdates.push({ p, dropped: null });

    await datastorePut(conn.secret, changes);
    for (const { p, dropped } of syncUpdates) markSynced(db, p, dropped);
    const skipped = await applyPull(db, participants, plan);

    const notes: string[] = [];
    // The push direction is a silent no-op without Seerr: `imdbForTmdb` is the ONLY forward
    // tmdb -> imdb path, it returns null when no Seerr connection is enabled, and the reconciler
    // skips every item with a null imdb id. The pull keeps working, so the link looks healthy
    // while nothing pulse owns ever reaches Stremio. Say so out loud.
    const unresolved = pulseItems.filter((p) => p.imdbId === null).length;
    if (plan.push.length === 0 && unresolved > 0 && !seerr) {
      notes.push(
        `${unresolved} title(s) could not be pushed to Stremio: matching a pulse title to an ` +
        'IMDb id needs an enabled Seerr connection, and none is configured.'
      );
    }
    if (skipped > 0) {
      notes.push(`${skipped} title(s) saved in Stremio could not be imported this cycle (metadata lookup failed).`);
    }
    // recordHouseholdSuccess first: the credential itself worked, so lastSyncAt must advance and
    // failCount must reset. recordHouseholdNote then leaves the caveat visible instead of letting
    // the blanket lastError=null present a cycle that dropped every import as a clean one.
    recordHouseholdSuccess(db);
    if (notes.length) recordHouseholdNote(db, notes.join(' '));
  } catch (e) {
    const message = (e as Error).message;
    // `failCount` never decays, so counting every thrown error toward MAX_FAILS would let a brief
    // Stremio 5xx, a Cinemeta hiccup, or a DNS blip permanently disable an authKey that was never
    // invalid. Two signals mean the credential itself is dead: Stremio's own error code 1 =
    // "Invalid auth", carried in a 200 body, or an HTTP 401/403 from api.strem.io directly.
    const authDead = e instanceof StremioError && (e.code === 1 || e.status === 401 || e.status === 403);
    if (authDead) {
      recordHouseholdFailure(db, message);
    } else {
      recordHouseholdNote(db, message);
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/server/consumer/stremio-sync.test.ts src/lib/server/consumer/stremio-reconcile.test.ts`
Expected: PASS, with `stremio-reconcile.ts` and its test untouched (`git diff --stat` must not list them).

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/stremio-sync.ts src/lib/server/consumer/stremio-sync.test.ts
git commit -m "feat: household-scoped stremio sync with participant fan-out"
```

---

### Task 3: Admin API for the household connection

**Files:**
- Create: `src/routes/api/stremio/+server.ts`
- Create: `src/routes/api/stremio/test/+server.ts`
- Test: `src/routes/api/stremio/server.test.ts`

**Interfaces:**
- Consumes from Task 1: `readHousehold`, `saveStremioConnection`, `setParticipants`, `unlinkStremio`, `getStremioConnection`.
- Produces, for Task 4 (the UI fetches these):
  - `GET /api/stremio` → `{ linked: boolean; enabled: boolean; email: string; participantIds: number[]; lastSyncAt: number | null; lastError: string | null; consumers: Array<{ id: number; displayName: string }> }`
  - `POST /api/stremio` with `{ email, password }` → `{ ok: true }`; 400 on bad credentials, 502 unreachable, 429 rate-limited
  - `PATCH /api/stremio` with `{ participantIds: number[] }` → `{ ok: true, participantIds }`
  - `DELETE /api/stremio` → `{ ok: true }`
  - `POST /api/stremio/test` → `{ ok: true, total: number, active: number }` or `{ ok: false, message: string }`

Note: `src/hooks.server.ts` already rejects any unauthenticated `/api/` request and 404s the whole admin surface on `PULSE_PUBLIC_HOST`. The `locals.user` checks below are defence in depth and match `/api/users`.

- [ ] **Step 1: Write the failing tests**

Create `src/routes/api/stremio/server.test.ts`:

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { readHousehold, saveStremioConnection, setParticipants } from '$lib/server/consumer/household-stremio';

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
  await expect((POST as any)({
    locals: admin, request: req({ email: 'fixture@example.invalid', password: 'bad' }), getClientAddress: () => '1.1.1.1'
  })).rejects.toMatchObject({ status: 400 });

  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await expect((POST as any)({
    locals: admin, request: req({ email: 'fixture@example.invalid', password: 'p' }), getClientAddress: () => '1.1.1.1'
  })).rejects.toMatchObject({ status: 502 });
  expect(readHousehold(db)).toBeNull();
});

it('requires both email and password', async () => {
  const { POST } = await import('./+server');
  await expect((POST as any)({
    locals: admin, request: req({ email: '', password: 'p' }), getClientAddress: () => '1.1.1.1'
  })).rejects.toMatchObject({ status: 400 });
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

it('the test endpoint 400s when nothing is linked', async () => {
  const { POST } = await import('./test/+server');
  await expect((POST as any)({ locals: admin })).rejects.toMatchObject({ status: 400 });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/routes/api/stremio/server.test.ts`
Expected: FAIL — `Failed to resolve import "./+server"`.

- [ ] **Step 3: Write the endpoints**

Create `src/routes/api/stremio/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { stremioLogin, StremioError } from '$lib/server/integrations/stremio';
import {
  readHousehold, saveStremioConnection, setParticipants, unlinkStremio
} from '$lib/server/consumer/household-stremio';
import { listConsumers } from '$lib/server/identity/consumers';
import { logAccess } from '$lib/server/identity/access-log';
import { rateLimit } from '$lib/server/request-limit';

function requireAdmin(locals: App.Locals): void {
  // hooks.server.ts already gates every /api/ path on an admin session and 404s the admin
  // surface on PULSE_PUBLIC_HOST. This is defence in depth, matching /api/users.
  if (!locals.user) throw error(401, 'Unauthorized');
}

export const GET: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  const h = readHousehold(db);
  return json({
    linked: !!h,
    enabled: h?.connection.enabled ?? false,
    email: h?.email ?? '',
    participantIds: h?.participantIds ?? [],
    lastSyncAt: h?.lastSyncAt ?? null,
    lastError: h?.lastError ?? null,
    consumers: listConsumers(db).map((c) => ({ id: c.id, displayName: c.displayName }))
  });
};

export const POST: RequestHandler = async ({ locals, request, getClientAddress }) => {
  requireAdmin(locals);
  // An endpoint that takes a password must not be free to hammer. `rateLimit` RETURNS a result,
  // it does not throw.
  const limit = rateLimit(`stremio-household-link:${getClientAddress()}`, 5, 60_000);
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

  const db = getDb();
  saveStremioConnection(db, { email, authKey });
  logAccess(db, { consumerId: null, type: 'stremio_link' });
  return json({ ok: true });
};

export const PATCH: RequestHandler = async ({ locals, request }) => {
  requireAdmin(locals);
  const body = await request.json().catch(() => ({}));
  if (!Array.isArray(body?.participantIds)) throw error(400, 'participantIds must be an array');

  const db = getDb();
  // Filter against the real roster here as well as on read: a stale id in the stored blob is
  // tolerated (users get deleted), but there is no reason to write one in.
  const live = new Set(listConsumers(db).map((c) => c.id));
  const ids = (body.participantIds as unknown[])
    .filter((v): v is number => Number.isInteger(v) && live.has(v as number));

  setParticipants(db, ids);
  return json({ ok: true, participantIds: ids });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  requireAdmin(locals);
  const db = getDb();
  unlinkStremio(db);
  logAccess(db, { consumerId: null, type: 'stremio_unlink' });
  return json({ ok: true });
};
```

Create `src/routes/api/stremio/test/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { datastoreGet } from '$lib/server/integrations/stremio';
import { getStremioConnection } from '$lib/server/consumer/household-stremio';

/**
 * Probe the live Library and report what came back.
 *
 * The count is the point, not a health tick. `datastoreGet` asks for `all: true` against an
 * undocumented endpoint; if Stremio ever paginates, a title outside the page reads as absent,
 * gets re-pushed from a borrowed template with `state` zeroed, and `datastorePut` is a full
 * document replace — real cross-device watch progress would be destroyed. Comparing this number
 * against what the TV actually shows is the cheapest way to know that has not happened.
 */
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const conn = getStremioConnection(getDb());
  if (!conn || !conn.secret) throw error(400, 'Stremio is not linked');
  try {
    const items = await datastoreGet(conn.secret);
    return json({ ok: true, total: items.length, active: items.filter((i) => !i.removed).length });
  } catch (e) {
    // Never surfaces the authKey: StremioError's message is built without the request body.
    return json({ ok: false, message: (e as Error).message });
  }
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/routes/api/stremio/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/stremio
git commit -m "feat: admin api for the household stremio connection"
```

---

### Task 4: Admin panel, i18n, and removal of the per-viewer path

**Files:**
- Modify: `src/routes/settings/+page.svelte` (script block near line 430; markup at the `{#if activeTab === 'connections'}` block, line 1959; `<style>` block, line 2339)
- Modify: `src/routes/app/account/+page.svelte` (remove lines 131–185 region and the `conn-block` for Stremio around line 357)
- Delete: `src/routes/api/app/stremio/+server.ts` and `src/routes/api/app/stremio/server.test.ts`
- Modify: `src/lib/server/consumer/spoke-credentials.ts` (narrow `SpokeId`)
- Modify: `src/lib/server/consumer/spoke-credentials.test.ts` (it uses `'stremio'` as its second spoke value)
- Modify: `e2e/connections.spec.ts` (drop its two Stremio tests and the `/api/app/stremio` stubs)
- Modify: `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json`
- Test: `e2e/household-stremio.spec.ts`

**Interfaces:**
- Consumes from Task 3: the five endpoints listed there.
- Produces: nothing further tasks depend on.

**Playwright gotcha that WILL bite:** `src/service-worker.ts` intercepts every same-origin GET and re-issues it from inside the service worker, so `page.route()` GET mocks silently never fire (POST/PATCH/DELETE are unaffected, which makes it look like half the mocks work). Create the context with service workers off:

```ts
const context = await browser.newContext({ serviceWorkers: 'block' });
```

Confine that to the spec — do not change the app's service worker to make the test easier.

- [ ] **Step 1: Move the i18n strings**

In `src/lib/i18n/en.json`, delete the top-level `"stremio"` object and add, inside the existing `settings` object, a `stremio` key:

```json
"stremio": {
  "title": "Stremio (household)",
  "description": "One Stremio account, shared with the pulse users you pick below. Their watchlists and pending requests show up in the Stremio Library on the TV, and anything saved there comes back to all of them.",
  "email": "Stremio email",
  "password": "Stremio password",
  "connect": "Link Stremio",
  "relink": "Re-link",
  "disconnect": "Unlink",
  "linked": "Linked as {email}",
  "disabled": "Disabled after repeated sign-in failures — re-link to switch it back on.",
  "notLinked": "Not linked.",
  "participants": "Users who share this account",
  "participantsHint": "Only these users' lists are synced. Everyone else is untouched.",
  "noParticipants": "No users selected yet — nothing is being synced.",
  "noConsumers": "No pulse users exist yet.",
  "save": "Save participants",
  "saved": "Saved.",
  "test": "Check Library",
  "testOk": "{active} titles in the Library ({total} including removed ones).",
  "lastSync": "Last synced {when}",
  "never": "never",
  "badCredentials": "Stremio didn't accept that email and password.",
  "unreachable": "Couldn't reach Stremio. Try again in a moment.",
  "passwordNote": "The password is used once to sign in and is never stored."
}
```

And in `src/lib/i18n/pt-BR.json`, delete the top-level `"stremio"` object and add the same key set under `settings`:

```json
"stremio": {
  "title": "Stremio (casa)",
  "description": "Uma conta do Stremio, compartilhada com os usuários do pulse escolhidos abaixo. As listas e os pedidos pendentes deles aparecem na Biblioteca do Stremio na TV, e o que for salvo lá volta para todos eles.",
  "email": "E-mail do Stremio",
  "password": "Senha do Stremio",
  "connect": "Vincular Stremio",
  "relink": "Vincular de novo",
  "disconnect": "Desvincular",
  "linked": "Vinculado como {email}",
  "disabled": "Desativado depois de várias falhas de login — vincule de novo para religar.",
  "notLinked": "Não vinculado.",
  "participants": "Usuários que compartilham esta conta",
  "participantsHint": "Só as listas desses usuários são sincronizadas. Os outros não são tocados.",
  "noParticipants": "Nenhum usuário escolhido — nada está sendo sincronizado.",
  "noConsumers": "Ainda não existe nenhum usuário no pulse.",
  "save": "Salvar participantes",
  "saved": "Salvo.",
  "test": "Conferir Biblioteca",
  "testOk": "{active} títulos na Biblioteca ({total} contando os removidos).",
  "lastSync": "Última sincronização {when}",
  "never": "nunca",
  "badCredentials": "O Stremio não aceitou esse e-mail e senha.",
  "unreachable": "Não deu para falar com o Stremio. Tente de novo em instantes.",
  "passwordNote": "A senha é usada uma vez para entrar e não fica guardada."
}
```

- [ ] **Step 2: Remove the per-viewer path**

```bash
git rm -r src/routes/api/app/stremio
```

In `src/routes/app/account/+page.svelte`:
- delete the `// Stremio link state` block and the `loadStremio`, `connectStremio`, `disconnectStremio` functions;
- delete the call to `loadStremio()` wherever it is invoked (search for `loadStremio(`);
- delete the whole `<div class="conn-block">` containing `{$_('stremio.title')}`, leaving the Trakt block and the `<h2>{$_('app.connections')}</h2>` heading in place.

In `src/lib/server/consumer/spoke-credentials.ts`, narrow the union — Stremio no longer keys on a consumer:

```ts
/** Stremio is a HOUSEHOLD spoke and lives in `connections`; see consumer/household-stremio.ts. */
export type SpokeId = 'trakt';
```

That breaks `src/lib/server/consumer/spoke-credentials.test.ts`, which uses `'stremio'` as its
second spoke value at lines 51, 57 and 60 to prove the `(consumer_id, spoke)` primary key really
does key on both columns. Keep that coverage — do NOT delete those assertions and do NOT widen the
union to keep them compiling. Add near the top of that file:

```ts
// The primary key is (consumer_id, spoke), and these tests exist to prove the `spoke` half is
// load-bearing. Stremio has since moved to the household `connections` table, so there is no
// second SpokeId today; cast a placeholder rather than widen the union for a test's sake.
const OTHER_SPOKE = 'other-spoke' as SpokeId;
```

and replace the three `'stremio'` literals with `OTHER_SPOKE`. Import `type SpokeId` alongside the
existing imports.

In `e2e/connections.spec.ts`:
- delete the two tests named `Stremio: unlinked shows the form; a successful connect switches to Connected` and `Stremio: a 400 shows the bad-credentials copy and leaves the panel unlinked` (lines 75-140);
- in the two remaining `Trakt:` tests, delete the `await cp.route('**/api/app/stremio', ...)` stub lines — that endpoint no longer exists, so an unmocked call would 404 rather than hang;
- update the file's header comment so it describes the Trakt panel only.

- [ ] **Step 3: Run the suite and watch it fail**

Run: `npm test 2>&1 | tail -40 && npm run check 2>&1 | tail -20`
Expected: FAIL — `npm run check` reports any leftover `spoke: 'stremio'` that no longer type-checks and any unresolved `$_('stremio.*')` usage that was missed. Fix every site the compiler names. `grep -rli stremio src e2e` afterwards must list only: the household module and its test, `stremio-sync`/`stremio-reconcile`/`integrations/stremio` and their tests, `cinemeta.ts`, `watchlist.ts`, `agent/events.ts`, `api/stremio`, the two i18n files, the settings page, and `spoke-credentials.ts`/`.test.ts`.

- [ ] **Step 4: Add the admin panel script state**

In `src/routes/settings/+page.svelte`, inside the existing `<script>` block (place it next to the other `/api` loaders, around line 430), add:

```ts
  // ── Household Stremio ──
  type StremioState = {
    linked: boolean; enabled: boolean; email: string; participantIds: number[];
    lastSyncAt: number | null; lastError: string | null;
    consumers: Array<{ id: number; displayName: string }>;
  };
  let stremio = $state<StremioState | null>(null);
  let stremioEmail = $state('');
  let stremioPassword = $state('');
  let stremioPicked = $state<number[]>([]);
  let stremioBusy = $state(false);
  let stremioErr = $state<string | null>(null);
  let stremioMsg = $state<string | null>(null);
  let stremioShowForm = $state(false);

  async function loadStremio() {
    try {
      const r: StremioState = await fetch('/api/stremio').then((x) => x.json());
      stremio = r;
      stremioPicked = [...r.participantIds];
      stremioShowForm = !r.linked;
    } catch { /* ignore */ }
  }

  async function linkStremio() {
    stremioErr = null; stremioMsg = null; stremioBusy = true;
    const email = stremioEmail;
    const password = stremioPassword;
    // The password only ever needs to live long enough to build this one request body — clear it
    // from component state immediately rather than holding it for the lifetime of the request.
    stremioPassword = '';
    try {
      const res = await fetch('/api/stremio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      if (!res.ok) {
        stremioErr =
          res.status === 400 ? $_('settings.stremio.badCredentials')
          : res.status === 429 ? await res.text()
          : $_('settings.stremio.unreachable');
        return;
      }
      stremioEmail = '';
      await loadStremio();
    } catch {
      stremioErr = $_('settings.stremio.unreachable');
    } finally {
      stremioBusy = false;
    }
  }

  async function saveStremioParticipants() {
    stremioErr = null; stremioMsg = null; stremioBusy = true;
    try {
      await fetch('/api/stremio', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantIds: stremioPicked })
      });
      await loadStremio();
      stremioMsg = $_('settings.stremio.saved');
    } catch {
      stremioErr = $_('settings.stremio.unreachable');
    } finally {
      stremioBusy = false;
    }
  }

  async function unlinkStremioConn() {
    stremioBusy = true;
    try {
      await fetch('/api/stremio', { method: 'DELETE' });
      await loadStremio();
    } catch { /* ignore */ }
    finally { stremioBusy = false; }
  }

  async function testStremio() {
    stremioErr = null; stremioMsg = null; stremioBusy = true;
    try {
      const r = await fetch('/api/stremio/test', { method: 'POST' }).then((x) => x.json());
      if (r.ok) {
        stremioMsg = $_('settings.stremio.testOk', { values: { active: r.active, total: r.total } });
      } else {
        stremioErr = r.message ?? $_('settings.stremio.unreachable');
      }
    } catch {
      stremioErr = $_('settings.stremio.unreachable');
    } finally {
      stremioBusy = false;
    }
  }

  function toggleParticipant(id: number, on: boolean) {
    stremioPicked = on ? [...new Set([...stremioPicked, id])] : stremioPicked.filter((x) => x !== id);
  }
```

Then wire the loader. The settings page lazy-loads per tab (`if (activeTab === 'ai') void loadAi();`
inside `onMount`, and again in `setTab`), but Connections is the DEFAULT tab, so add an
UNCONDITIONAL call at the end of the existing `onMount` body (around line 71, after the
`selectedType` default-selection block):

```ts
    void loadStremio();
```

Do NOT add it to `setTab` — the state persists once loaded, and a second call on every tab switch
would re-fetch for nothing.

- [ ] **Step 5: Add the panel markup**

In `src/routes/settings/+page.svelte`, immediately after the `{#if activeTab === 'connections'}` line and BEFORE `<div class="master-detail" ...>`, insert:

```svelte
    <!--
      Stremio is a HOUSEHOLD integration, not a per-connection one: one account, one authKey,
      and an explicit list of which pulse users share it. It deliberately does NOT go through
      the generic connection form below — that form stores whatever is typed into its password
      box as the connection secret, and Stremio's secret must be the authKey the password is
      exchanged for, never the password itself.
    -->
    <section class="hh-card">
      <h3>{$_('settings.stremio.title')}</h3>
      <p class="hint">{$_('settings.stremio.description')}</p>

      {#if stremio?.linked}
        <p class="hh-status">
          <span class="badge badge-ok">{$_('settings.stremio.linked', { values: { email: stremio.email } })}</span>
        </p>
        {#if !stremio.enabled}
          <p class="err">{$_('settings.stremio.disabled')}</p>
        {/if}
        {#if stremio.lastError}
          <p class="err">{stremio.lastError}</p>
        {/if}
        <p class="hint">
          {$_('settings.stremio.lastSync', { values: {
            when: stremio.lastSyncAt ? new Date(stremio.lastSyncAt).toLocaleString() : $_('settings.stremio.never')
          } })}
        </p>

        <fieldset class="hh-participants">
          <legend>{$_('settings.stremio.participants')}</legend>
          <p class="hint">{$_('settings.stremio.participantsHint')}</p>
          {#if stremio.consumers.length === 0}
            <p class="empty-hint">{$_('settings.stremio.noConsumers')}</p>
          {:else}
            {#each stremio.consumers as c (c.id)}
              <label class="hh-check">
                <input
                  type="checkbox"
                  checked={stremioPicked.includes(c.id)}
                  onchange={(e) => toggleParticipant(c.id, (e.currentTarget as HTMLInputElement).checked)}
                />
                {c.displayName}
              </label>
            {/each}
          {/if}
          {#if stremioPicked.length === 0}
            <p class="hint">{$_('settings.stremio.noParticipants')}</p>
          {/if}
        </fieldset>

        <div class="form-actions">
          <button type="button" class="btn btn-s" onclick={testStremio} disabled={stremioBusy}>{$_('settings.stremio.test')}</button>
          <button type="button" class="btn btn-s" onclick={() => { stremioShowForm = true; }} disabled={stremioBusy}>{$_('settings.stremio.relink')}</button>
          <button type="button" class="btn btn-s" onclick={unlinkStremioConn} disabled={stremioBusy}>{$_('settings.stremio.disconnect')}</button>
          <button type="button" class="btn btn-p" onclick={saveStremioParticipants} disabled={stremioBusy}>{$_('settings.stremio.save')}</button>
        </div>
      {:else}
        <p class="hint">{$_('settings.stremio.notLinked')}</p>
      {/if}

      {#if stremioShowForm}
        <form class="hh-form" onsubmit={(e) => { e.preventDefault(); linkStremio(); }}>
          <div class="field-row">
            <label for="stremio-email">{$_('settings.stremio.email')}</label>
            <input id="stremio-email" class="field-input" type="email" bind:value={stremioEmail} autocomplete="email" required />
          </div>
          <div class="field-row">
            <label for="stremio-password">{$_('settings.stremio.password')}</label>
            <input id="stremio-password" class="field-input" type="password" bind:value={stremioPassword} autocomplete="new-password" required />
          </div>
          <p class="hint">{$_('settings.stremio.passwordNote')}</p>
          <div class="form-actions">
            <button type="submit" class="btn btn-p" disabled={stremioBusy || !stremioEmail || !stremioPassword}>{$_('settings.stremio.connect')}</button>
          </div>
        </form>
      {/if}

      {#if stremioErr}<p class="err">{stremioErr}</p>{/if}
      {#if stremioMsg}<p class="test-result test-ok">{stremioMsg}</p>{/if}
    </section>
```

Append to the `<style>` block at line 2339:

```css
  .hh-card {
    margin-bottom: 18px;
    padding: 14px 16px;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.02);
  }
  .hh-card h3 { margin: 0 0 4px; font-size: 14px; }
  .hh-status { margin: 8px 0 4px; }
  .hh-participants {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
  }
  .hh-participants legend { font-size: 12px; color: var(--sub); padding: 0 4px; }
  .hh-check { display: flex; align-items: center; gap: 8px; font-size: 13px; margin: 4px 0; }
  .hh-form { margin-top: 10px; }
```

- [ ] **Step 6: Write the e2e spec**

Create `e2e/household-stremio.spec.ts`, following the structure of the existing `e2e/connections.spec.ts` for admin login:

```ts
import { test, expect } from '@playwright/test';

// The app's service worker re-issues every same-origin GET from inside itself, which silently
// defeats page.route() GET mocks (POST/PATCH/DELETE still work, so half the mocks appear fine).
// Block service workers for this context. Do NOT change the app's SW to suit the test.
test('admin links Stremio, picks participants, and unlinks', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();

  let linked = false;
  let participants: number[] = [];

  await page.route('**/api/stremio', async (route) => {
    const m = route.request().method();
    if (m === 'GET') {
      return route.fulfill({
        json: {
          linked, enabled: true, email: linked ? 'fixture-account@example.invalid' : '',
          participantIds: participants, lastSyncAt: null, lastError: null,
          consumers: [{ id: 2, displayName: 'Jader' }, { id: 3, displayName: 'Jessica' }]
        }
      });
    }
    if (m === 'POST') { linked = true; return route.fulfill({ json: { ok: true } }); }
    if (m === 'PATCH') {
      participants = JSON.parse(route.request().postData() ?? '{}').participantIds ?? [];
      return route.fulfill({ json: { ok: true, participantIds: participants } });
    }
    if (m === 'DELETE') { linked = false; participants = []; return route.fulfill({ json: { ok: true } }); }
    return route.continue();
  });

  // <login as admin exactly as e2e/connections.spec.ts does, then:>
  await page.goto('/settings#connections');

  await page.getByLabel('Stremio email').fill('fixture-account@example.invalid');
  await page.getByLabel('Stremio password').fill('fixture-not-a-password');
  await page.getByRole('button', { name: 'Link Stremio' }).click();
  await expect(page.getByText('Linked as tv@home.lan')).toBeVisible();

  await page.getByLabel('Jader').check();
  await page.getByRole('button', { name: 'Save participants' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(participants).toEqual([2]);

  await page.getByRole('button', { name: 'Unlink' }).click();
  await expect(page.getByText('Not linked.')).toBeVisible();

  await context.close();
});
```

Copy the admin login steps verbatim from `e2e/connections.spec.ts` rather than inventing them.

- [ ] **Step 7: Run everything**

Run: `npm test && npm run check && npm run e2e -- household-stremio`
Expected: PASS on all three. `dictionaries.test.ts` in particular must pass, proving en and pt-BR carry the same key set.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: household stremio admin panel; drop the per-viewer stremio link"
```

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| One `connections` row, `type='stremio'`, secret = authKey, options = `{email, participantIds}` | 1 |
| Password never stored | 1 (module), 3 (endpoint + test asserting it) |
| Non-participants untouched | 2 (`loadPulseItems` test), 3 (PATCH filter) |
| Union of watchlists + not-yet-available requests | 2 |
| Import fans out to every participant | 2 |
| Removal on the TV fans out to every participant | 2 |
| Outbound removal is union-scoped, not a fan-out | 2 (ruling, comment, test) |
| Drop when available, unchanged | 2 (existing tests ported) |
| `stremio-reconcile.ts` unmodified | 2 (Step 4 asserts it is absent from the diff) |
| `sync_state` → `household_sync_state` | 1 (schema), 2 (all reads/writes) |
| No migration needed | verified against the live DB on 2026-08-29: 0 stremio rows in `spoke_credentials` and `sync_state` |
| Stale participant id skipped silently | 1 |
| Fail closed / 401-403 vs transient split | 1 (health trio), 2 (`authDead` branch), tested in both |
| Consumer Stremio panel removed, Trakt's kept | 4 |
| Admin UI in dash → Connections | 4 |
| Trakt stays per-viewer | untouched; Task 4 only narrows `SpokeId` to `'trakt'` |

**Placeholder scan.** None: every code step carries the code, every test step carries the assertions, and the one "copy from the neighbouring file" instruction (the e2e admin login) names the exact file.

**Type consistency.** `loadPulseItems(db, participants: number[], seerr)` and `applyPull(db, participants: number[], plan)` are used with array arguments in Task 2's tests and in `pollStremioSync`. `readHousehold` returns `StremioHousehold | null` and every consumer null-checks it. `participantIds` is both a module function (Task 1) and a response field name (Task 3) — different namespaces, no collision. `MAX_FAILS` is imported from `spoke-credentials`, which Task 4 narrows the `SpokeId` of but does not otherwise touch.

## Parked follow-ups

Carried over, still true, and deliberately not in scope:

- `MAX_IMPORTS_PER_CYCLE = 25` can be starved by a run of ids Cinemeta cannot resolve.
- A title someone saves in Stremio never drops when it lands on the server, because the import gives it `on_server = 0` and only the availability poller flips that.
- Cinemeta-negative titles re-hit Seerr every cycle.
- **The smoke gate stays open:** `datastoreGet` asks for `all: true` and has never been probed against the live API. `POST /api/stremio/test` exists precisely so this can be checked — compare its `active` count against what the TV shows BEFORE trusting any write, because `datastorePut` is a full-document replace and a paginated read would zero real watch progress.
