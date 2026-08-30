# Watchlist Screen and Household Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the consumer app a watchlist screen, and make removing a title actually remove it — from every participant and from the Stremio Library on the TV.

**Architecture:** A new `household_removals` table acts as a transient work queue. Removing a title deletes it from every participant's watchlist and enqueues one row; the next Stremio poll pushes `removed: true` for those titles and — crucially — excludes their ids from the list handed to the reconciler, which is what stops them being re-imported in the gap. Once the write lands the queue rows are dropped, and Stremio's own `removed` flag keeps the title out. The screen is a second view on the existing Requests page, not a sixth nav tab.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, better-sqlite3, vitest, Playwright, svelte-i18n.

**Spec:** `docs/superpowers/specs/2026-08-30-watchlist-screen-and-household-removal.md`

## Global Constraints

- **`stremio-reconcile.ts` and `stremio-reconcile.test.ts` MUST NOT be modified.** The reconciler takes two lists; choosing what goes in those lists is the orchestrator's job. If you believe it needs changing, stop and report BLOCKED.
- **`migrate()` in `src/lib/server/db.ts` has no `ALTER` path and is uncaught in `getDb()`** — a throwing statement stops the app booting. New schema is `CREATE TABLE IF NOT EXISTS` only.
- **better-sqlite3 transactions are synchronous.** Never `await` inside `db.transaction(...)`.
- **`foreign_keys = ON`.** `migrate()` auto-seeds an Admin role at id=1, so fixtures use role id=2 and seed `roles` before `consumer_users`.
- **Tests must never open the real `pulse.sqlite`** — `openDb(':memory:')` + `migrate(db)`.
- **Every user-visible string goes through svelte-i18n and must exist in BOTH `src/lib/i18n/en.json` and `src/lib/i18n/pt-BR.json`.** `dictionaries.test.ts` fails on any asymmetry or empty value. The `app.*` namespace is flat (no nesting under `app`).
- **pt-BR copy is direct, never corporate-cutesy.** Plain wording, no translated corporate idioms.
- **Never log or interpolate the Stremio authKey.**
- **No assistant attribution in commit messages.** Plain messages only.
- Verify with `npm test`, `npm run check`, and `npx playwright test e2e/<file>` (note: `npm run e2e -- <name>` does NOT filter — it runs everything). One pre-existing unrelated failure exists in `e2e/accounts.spec.ts:98`; it fails on master too. Ignore it.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/server/db.ts` | **Modify** — add `household_removals`. |
| `src/lib/server/consumer/household-removals.ts` | **Create** — enqueue/list/clear the queue, and resolve the imdb id at enqueue time. |
| `src/lib/server/consumer/household-removals.test.ts` | **Create**. |
| `src/lib/server/consumer/stremio-sync.ts` | **Modify** — drain the queue: push `removed: true`, exclude the ids from the reconciler's input, clear on success. |
| `src/lib/server/consumer/stremio-sync.test.ts` | **Modify** — add the removal-propagation and no-re-import tests. |
| `src/lib/server/consumer/watchlist-remove.ts` | **Create** — the shared household-aware removal, used by BOTH the endpoint and the chat tool. |
| `src/routes/api/app/watchlist/+server.ts` | **Create** — `GET` + `DELETE`. |
| `src/lib/server/agent/tools.ts` | **Modify** — `watchlistRemove` calls the shared removal. |
| `src/routes/api/app/watchlist/server.test.ts` | **Create**. |
| `src/routes/app/requests/+page.svelte` | **Modify** — segmented toggle, watchlist view, remove button. |
| `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json` | **Modify** — new `app.*` keys. |
| `e2e/watchlist.spec.ts` | **Create**. |

---

### Task 1: `household_removals` table and its module

**Files:**
- Modify: `src/lib/server/db.ts` (after the `household_sync_state` table)
- Create: `src/lib/server/consumer/household-removals.ts`
- Test: `src/lib/server/consumer/household-removals.test.ts`

**Interfaces:**
- Consumes: `DB` from `../db`.
- Produces, for Tasks 2 and 3:
  - `enqueueHouseholdRemoval(db, { tmdbId, mediaType }): void` — resolves the imdb id from `imdb_meta_cache` and upserts one row.
  - `listHouseholdRemovals(db): Array<{ tmdbId: number; mediaType: 'movie' | 'tv'; imdbId: string | null; removedAt: number }>`
  - `clearHouseholdRemovals(db, keys: Array<{ tmdbId: number; mediaType: string }>): void`

- [ ] **Step 1: Add the table to `migrate()`**

In `src/lib/server/db.ts`, immediately after the `CREATE TABLE IF NOT EXISTS household_sync_state (...);` statement, add:

```sql
    -- Transient work queue: a title a participant removed in pulse, which still has to be
    -- tombstoned in the Stremio Library. It is NOT a permanent tombstone. Deleting the pulse
    -- rows alone is exactly the state the reconciler reads as "present in Stremio, unknown to
    -- pulse, import it", so the title would come straight back. Rows live only until the
    -- removed=true write lands; after that Stremio's own removed flag keeps the title out, and
    -- re-saving it on the TV imports it again as normal.
    CREATE TABLE IF NOT EXISTS household_removals (
      spoke       TEXT NOT NULL,
      tmdb_id     INTEGER NOT NULL,
      media_type  TEXT NOT NULL,
      imdb_id     TEXT,
      removed_at  INTEGER NOT NULL,
      PRIMARY KEY (spoke, tmdb_id, media_type)
    );
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/server/consumer/household-removals.test.ts`:

```ts
import { it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  enqueueHouseholdRemoval, listHouseholdRemovals, clearHouseholdRemovals
} from './household-removals';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

function seedMeta(imdb: string, tmdb: number, type: 'movie' | 'series'): void {
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES (?,?,?,'X',NULL,1,?)`
  ).run(imdb, type, tmdb, Date.now());
}

it('resolves the imdb id at enqueue time from the cache', () => {
  seedMeta('tt0111161', 278, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 278, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)).toEqual([
    { tmdbId: 278, mediaType: 'movie', imdbId: 'tt0111161', removedAt: expect.any(Number) }
  ]);
});

it('maps a tv row to the series cache key, not the movie one', () => {
  // The cache is keyed (imdb_id, media_type) with 'series' for tv. Looking up 'tv' finds nothing
  // and would silently enqueue an unpushable row.
  seedMeta('tt0903747', 1396, 'series');
  enqueueHouseholdRemoval(db, { tmdbId: 1396, mediaType: 'tv' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBe('tt0903747');
});

it('does not confuse a movie and a series that share a tmdb id', () => {
  seedMeta('tt_movie', 42, 'movie');
  seedMeta('tt_series', 42, 'series');
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 42, mediaType: 'tv' });
  const rows = listHouseholdRemovals(db).sort((a, b) => a.mediaType.localeCompare(b.mediaType));
  expect(rows.map((r) => [r.mediaType, r.imdbId])).toEqual([
    ['movie', 'tt_movie'], ['tv', 'tt_series']
  ]);
});

it('enqueues with a null imdb id when the cache cannot resolve it', () => {
  enqueueHouseholdRemoval(db, { tmdbId: 999, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBeNull();
});

it('ignores a cache row marked as a permanent negative', () => {
  // found=0 is how a real Cinemeta miss is cached forever. Its imdb_id is a key, not an answer:
  // enqueuing it would push a removal for an id Stremio never had.
  db.prepare(
    `INSERT INTO imdb_meta_cache(imdb_id,media_type,tmdb_id,name,poster,found,cached_at)
     VALUES ('tt_bogus','movie',555,NULL,NULL,0,?)`
  ).run(Date.now());
  enqueueHouseholdRemoval(db, { tmdbId: 555, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)[0].imdbId).toBeNull();
});

it('re-enqueuing the same title refreshes it rather than duplicating', () => {
  seedMeta('tt1', 1, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});

it('clears only the keys it is given', () => {
  seedMeta('tt1', 1, 'movie'); seedMeta('tt2', 2, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  enqueueHouseholdRemoval(db, { tmdbId: 2, mediaType: 'movie' });
  clearHouseholdRemovals(db, [{ tmdbId: 1, mediaType: 'movie' }]);
  expect(listHouseholdRemovals(db).map((r) => r.tmdbId)).toEqual([2]);
});

it('clearing an empty list is a no-op that does not wipe the queue', () => {
  seedMeta('tt1', 1, 'movie');
  enqueueHouseholdRemoval(db, { tmdbId: 1, mediaType: 'movie' });
  clearHouseholdRemovals(db, []);
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/lib/server/consumer/household-removals.test.ts`
Expected: FAIL — `Failed to resolve import "./household-removals"`.

- [ ] **Step 4: Write the module**

Create `src/lib/server/consumer/household-removals.ts`:

```ts
import type { DB } from '../db';

const SPOKE = 'stremio';

export interface HouseholdRemoval {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  imdbId: string | null;
  removedAt: number;
}

/**
 * Queue a title a participant removed in pulse, so the next poll can tombstone it in Stremio.
 *
 * The imdb id is resolved HERE, not at push time: once the watchlist rows are gone this queue row
 * is the only place the tmdb -> imdb mapping survives, and re-deriving it later would need Seerr.
 * A row that cannot be resolved is still worth keeping — it suppresses the re-import by tmdb id —
 * but it can never be pushed, so the drain drops it rather than retrying forever.
 */
export function enqueueHouseholdRemoval(
  db: DB, v: { tmdbId: number; mediaType: string }
): void {
  const mediaType = v.mediaType === 'tv' ? 'tv' : 'movie';
  // imdb_meta_cache keys tv rows as 'series'. `found = 1` matters: found=0 is how a permanent
  // Cinemeta negative is cached, and its imdb_id is the cache KEY, not a resolved answer —
  // pushing a removal for it would tombstone an id the Library never had.
  const cached = db.prepare(
    `SELECT imdb_id FROM imdb_meta_cache
      WHERE tmdb_id = ? AND media_type = ? AND found = 1`
  ).get(v.tmdbId, mediaType === 'tv' ? 'series' : 'movie') as { imdb_id?: string } | undefined;

  db.prepare(
    `INSERT INTO household_removals(spoke,tmdb_id,media_type,imdb_id,removed_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(spoke,tmdb_id,media_type) DO UPDATE SET
       imdb_id = excluded.imdb_id, removed_at = excluded.removed_at`
  ).run(SPOKE, v.tmdbId, mediaType, cached?.imdb_id ?? null, Date.now());
}

export function listHouseholdRemovals(db: DB): HouseholdRemoval[] {
  return (db.prepare(
    'SELECT tmdb_id, media_type, imdb_id, removed_at FROM household_removals WHERE spoke = ?'
  ).all(SPOKE) as any[]).map((r) => ({
    tmdbId: r.tmdb_id,
    mediaType: r.media_type === 'tv' ? 'tv' : 'movie',
    imdbId: r.imdb_id ?? null,
    removedAt: r.removed_at
  }));
}

export function clearHouseholdRemovals(
  db: DB, keys: Array<{ tmdbId: number; mediaType: string }>
): void {
  if (keys.length === 0) return; // guard: a blanket DELETE here would drop pending work
  const stmt = db.prepare(
    'DELETE FROM household_removals WHERE spoke = ? AND tmdb_id = ? AND media_type = ?'
  );
  db.transaction(() => {
    for (const k of keys) stmt.run(SPOKE, k.tmdbId, k.mediaType === 'tv' ? 'tv' : 'movie');
  })();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/server/consumer/household-removals.test.ts src/lib/server/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/db.ts src/lib/server/consumer/household-removals.ts src/lib/server/consumer/household-removals.test.ts
git commit -m "feat: household removal queue"
```

---

### Task 2: Drain the queue in the Stremio poll

**Files:**
- Modify: `src/lib/server/consumer/stremio-sync.ts`
- Test: `src/lib/server/consumer/stremio-sync.test.ts` (append; do not weaken existing tests)
- Do NOT touch: `src/lib/server/consumer/stremio-reconcile.ts`

**Interfaces:**
- Consumes from Task 1: `listHouseholdRemovals`, `clearHouseholdRemovals`.
- Produces: no new exports. `pollStremioSync(db)` keeps its signature.

**The ordering that makes this work — read before coding.** The exclusion must happen BEFORE `reconcile` is called. If a queued title reaches the reconciler it is classified as "present in Stremio, unknown to pulse" and re-imported, which is the exact bug being fixed. The push document must be built by read-modify-write from the item `datastoreGet` returned, so the viewer's `state` (cross-device watch progress) survives — `datastorePut` is a full-document replace.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/server/consumer/stremio-sync.test.ts`:

```ts
// --- household removals ---

/** Queue a removal the way the endpoint does, without needing the endpoint. */
function queueRemoval(tmdbId: number, mediaType: 'movie' | 'tv'): void {
  db.prepare(
    `INSERT INTO household_removals(spoke,tmdb_id,media_type,imdb_id,removed_at)
     VALUES ('stremio',?,?,(SELECT imdb_id FROM imdb_meta_cache
        WHERE tmdb_id=? AND media_type=? AND found=1),?)`
  ).run(tmdbId, mediaType, tmdbId, mediaType === 'tv' ? 'series' : 'movie', Date.now());
}

it('CRITICAL: a queued removal is tombstoned in Stremio instead of being re-imported', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  queueRemoval(278, 'movie');
  // The title is still present in the Library and absent from every watchlist — which is exactly
  // the state the reconciler reads as "unknown to pulse, import it".
  const { puts } = stubStremio([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false, state: { timeOffset: 4200 } }
  ]);

  await pollStremioSync(db);

  expect(puts).toHaveLength(1);
  expect(puts[0].changes).toHaveLength(1);
  expect(puts[0].changes[0]._id).toBe('tt0111161');
  expect(puts[0].changes[0].removed).toBe(true);
  // and it must NOT have been imported back into anyone
  expect(listWatchlist(db, consumerId)).toEqual([]);
  expect(listWatchlist(db, otherId)).toEqual([]);
});

it('CRITICAL: tombstoning a removal preserves the viewer watch progress', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  const { puts } = stubStremio([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false,
      poster: 'p.jpg', _ctime: '2020-01-01T00:00:00.000Z', state: { timeOffset: 4200, watched: 'yes' } }
  ]);

  await pollStremioSync(db);

  // read-modify-write: datastorePut is a full-document REPLACE, so a rebuilt document would
  // erase real cross-device progress.
  expect(puts[0].changes[0].state).toEqual({ timeOffset: 4200, watched: 'yes' });
  expect(puts[0].changes[0].poster).toBe('p.jpg');
  expect(puts[0].changes[0]._ctime).toBe('2020-01-01T00:00:00.000Z');
});

it('clears the queue only after datastorePut succeeds', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [
        { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }
      ] }), { status: 200 });
    }
    return new Response('boom', { status: 500 }); // datastorePut fails
  }) as any);

  await pollStremioSync(db);

  // The row must survive so the next cycle retries; dropping it would leave the title live on
  // the TV forever with nothing left to push it.
  expect(listHouseholdRemovals(db)).toHaveLength(1);
  // and it still must not have been imported back
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('drops the queue row once the tombstone has landed', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  stubStremio([{ _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }]);
  await pollStremioSync(db);
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('drops a queued removal for a title Stremio no longer has, without pushing', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  const { puts } = stubStremio([]); // already gone
  await pollStremioSync(db);
  expect(puts).toHaveLength(0);
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('drops an unresolvable queued removal instead of retrying it forever', async () => {
  link([consumerId]);
  queueRemoval(4242, 'movie'); // no imdb_meta_cache row -> imdb_id null
  const { puts } = stubStremio([{ _id: 'tt_other', name: 'Other', type: 'movie', removed: false }]);
  await pollStremioSync(db);
  expect(puts.length === 0 || puts[0].changes.every((c: any) => c._id !== null)).toBe(true);
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('a removal queued for a title someone re-saved on the TV still tombstones it', async () => {
  // The queue is authoritative for one cycle: the person who removed it in pulse acted last.
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  const { puts } = stubStremio([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }
  ]);
  await pollStremioSync(db);
  expect(puts[0].changes[0].removed).toBe(true);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});
```

Add `listHouseholdRemovals` to the file's imports from `./household-removals`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/server/consumer/stremio-sync.test.ts`
Expected: FAIL — the queue is never read, so titles are re-imported and no `removed: true` is pushed.

- [ ] **Step 3: Implement the drain**

In `src/lib/server/consumer/stremio-sync.ts`, add to the imports:

```ts
import { listHouseholdRemovals, clearHouseholdRemovals } from './household-removals';
```

Inside `pollStremioSync`, immediately after `const library = await datastoreGet(conn.secret);` and
BEFORE `stremioItems` is built, insert:

```ts
    // ── Drain the household removal queue ───────────────────────────────────────────────
    // A title a participant removed in pulse is, right now, present in the Library and absent
    // from every watchlist — which is exactly the condition the reconciler reads as "unknown to
    // pulse, import it". So these ids are handled HERE and then hidden from the reconciler
    // entirely; letting one reach it would re-import the title and undo the removal.
    const pendingRemovals = listHouseholdRemovals(db);
    const removalById = new Map(
      pendingRemovals.filter((r) => r.imdbId).map((r) => [r.imdbId as string, r])
    );
    const excluded = new Set(removalById.keys());
    const removalChanges: StremioLibraryItem[] = [];
    for (const item of library) {
      if (!removalById.has(item._id) || item.removed) continue;
      // read-modify-write: only `removed` and `_mtime` are ours. `state` is the household's real
      // cross-device watch progress and datastorePut is a full-document replace.
      removalChanges.push({ ...item, removed: true, _mtime: new Date().toISOString() });
    }
    // Every queued row is settled this cycle: one that was pushed, one whose title Stremio no
    // longer has, and one we could never resolve an imdb id for all reach the same end state —
    // nothing left to do. Retrying an unpushable row forever would leak the queue.
    const settledRemovals = pendingRemovals.map((r) => ({ tmdbId: r.tmdbId, mediaType: r.mediaType }));
```

Change the `stremioItems` construction to filter the excluded ids:

```ts
    const stremioItems: StremioItem[] = library
      .filter((i) => !excluded.has(i._id))
      .map((i) => ({ imdbId: i._id, type: i.type, removed: i.removed }));
```

Seed `changes` with the removal documents by changing its declaration:

```ts
    const changes: StremioLibraryItem[] = [...removalChanges];
```

And after the existing `for (const { p, dropped } of syncUpdates) markSynced(db, p, dropped);` line,
add the clear — it must come after `datastorePut` resolved, for the same reason the `sync_state`
drain does:

```ts
    clearHouseholdRemovals(db, settledRemovals);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/server/consumer/stremio-sync.test.ts src/lib/server/consumer/stremio-reconcile.test.ts`
Expected: PASS, all pre-existing tests included. Then confirm the reconciler is untouched:
`git diff --name-only` must not list `stremio-reconcile.ts` or `stremio-reconcile.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/consumer/stremio-sync.ts src/lib/server/consumer/stremio-sync.test.ts
git commit -m "fix: propagate pulse-side watchlist removals to the stremio library"
```

---

### Task 3: The watchlist API

**Files:**
- Create: `src/routes/api/app/watchlist/+server.ts`
- Test: `src/routes/api/app/watchlist/server.test.ts`

**Interfaces:**
- Consumes: `listWatchlist`, `removeWatchlist` from `$lib/server/consumer/watchlist`; `enqueueHouseholdRemoval` from Task 1; `getStremioConnection`, `participantIds` from `$lib/server/consumer/household-stremio`; `mirrorFavorite` from `$lib/server/consumer/jellyfin-favorite`; `getConsumer`, `effectiveAllowList` from `$lib/server/identity/consumers`; `getRole` from `$lib/server/identity/roles`.
- Produces:
  - `removeWatchlistEverywhere(db, { actorId, tmdbId, mediaType }): Promise<{ removed: boolean; household: boolean }>` in `src/lib/server/consumer/watchlist-remove.ts` — the single implementation of household-aware removal, consumed by the endpoint AND by `watchlistRemove` in `src/lib/server/agent/tools.ts`.
  - `GET /api/app/watchlist` → `Array<{ id, tmdbId, mediaType, title, onServer, notifyOnAvailable, addedAt }>` (newest first; `consumerId` projected away)
  - `DELETE /api/app/watchlist` body `{ tmdbId, mediaType }` → `{ ok: true, household: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `src/routes/api/app/watchlist/server.test.ts`:

```ts
import { it, expect, beforeEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { addWatchlist, listWatchlist } from '$lib/server/consumer/watchlist';
import { saveStremioConnection, setParticipants } from '$lib/server/consumer/household-stremio';
import { listHouseholdRemovals } from '$lib/server/consumer/household-removals';

let db: DB;
let a: number;
let b: number;
let outsider: number;

vi.mock('$lib/server/db', async (orig) => {
  const real = await orig<typeof import('$lib/server/db')>();
  return { ...real, getDb: () => db };
});

beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare("INSERT INTO roles(id,name,allow_list,created_at) VALUES (2,'viewer',?,?)")
    .run(JSON.stringify(['discover', 'request', 'watchlist']), Date.now());
  db.prepare("INSERT INTO roles(id,name,allow_list,created_at) VALUES (3,'basic',?,?)")
    .run(JSON.stringify(['discover']), Date.now());
  const mk = (n: string, role = 2) => Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (?,?,'active',?)"
  ).run(role, n, Date.now()).lastInsertRowid);
  a = mk('Jader'); b = mk('Jessica'); outsider = mk('Guest');
});

const as = (id: number) => ({ consumer: { id } }) as any;
const del = (body: unknown) => new Request('http://x/api/app/watchlist', {
  method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
});

it('rejects an unauthenticated caller', async () => {
  const { GET, DELETE } = await import('./+server');
  await expect((GET as any)({ locals: { consumer: null } })).rejects.toMatchObject({ status: 401 });
  await expect((DELETE as any)({ locals: { consumer: null }, request: del({ tmdbId: 1, mediaType: 'movie' }) }))
    .rejects.toMatchObject({ status: 401 });
});

it('rejects a viewer whose role lacks the watchlist capability', async () => {
  const basic = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (3,'Basic','active',?)"
  ).run(Date.now()).lastInsertRowid);
  const { GET } = await import('./+server');
  await expect((GET as any)({ locals: as(basic) })).rejects.toMatchObject({ status: 403 });
});

it('returns the viewer own rows newest first, without leaking consumerId', async () => {
  addWatchlist(db, { consumerId: a, tmdbId: 1, mediaType: 'movie', title: 'One', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: b, tmdbId: 2, mediaType: 'movie', title: 'Two', onServer: false, notifyOnAvailable: true });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: as(a) })).json();
  expect(body.map((r: any) => r.title)).toEqual(['One']);
  expect(body[0].consumerId).toBeUndefined();
  expect(body[0]).toMatchObject({ tmdbId: 1, mediaType: 'movie', onServer: false });
});

it('removing as a participant removes it for EVERY participant and queues the tombstone', async () => {
  for (const id of [a, b]) {
    addWatchlist(db, { consumerId: id, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  }
  addWatchlist(db, { consumerId: outsider, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  saveStremioConnection(db, { email: 'tv@home.lan', authKey: 'ak' });
  setParticipants(db, [a, b]);

  const { DELETE } = await import('./+server');
  const res = await (DELETE as any)({ locals: as(a), request: del({ tmdbId: 278, mediaType: 'movie' }) });
  expect(await res.json()).toEqual({ ok: true, household: true });

  expect(listWatchlist(db, a)).toEqual([]);
  expect(listWatchlist(db, b)).toEqual([]);
  // a non-participant is NOT part of the household list and must keep their private row
  expect(listWatchlist(db, outsider)).toHaveLength(1);
  expect(listHouseholdRemovals(db)).toHaveLength(1);
});

it('removing as a NON-participant is local only and queues nothing', async () => {
  addWatchlist(db, { consumerId: outsider, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: a, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: false });
  saveStremioConnection(db, { email: 'tv@home.lan', authKey: 'ak' });
  setParticipants(db, [a, b]);

  const { DELETE } = await import('./+server');
  const res = await (DELETE as any)({ locals: as(outsider), request: del({ tmdbId: 278, mediaType: 'movie' }) });
  expect(await res.json()).toEqual({ ok: true, household: false });
  expect(listWatchlist(db, outsider)).toEqual([]);
  expect(listWatchlist(db, a)).toHaveLength(1); // untouched
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('removing with no household connection at all is local only', async () => {
  addWatchlist(db, { consumerId: a, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: false });
  const { DELETE } = await import('./+server');
  const res = await (DELETE as any)({ locals: as(a), request: del({ tmdbId: 278, mediaType: 'movie' }) });
  expect(await res.json()).toEqual({ ok: true, household: false });
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('removing a title nobody has is a clean no-op, not a queued removal', async () => {
  saveStremioConnection(db, { email: 'tv@home.lan', authKey: 'ak' });
  setParticipants(db, [a, b]);
  const { DELETE } = await import('./+server');
  const res = await (DELETE as any)({ locals: as(a), request: del({ tmdbId: 999, mediaType: 'movie' }) });
  expect(await res.json()).toEqual({ ok: false, household: false });
  // queuing a tombstone for a title the household never had would push a removal for nothing
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('rejects a malformed delete body', async () => {
  const { DELETE } = await import('./+server');
  for (const body of [{}, { tmdbId: 'x', mediaType: 'movie' }, { tmdbId: 0, mediaType: 'movie' }]) {
    await expect((DELETE as any)({ locals: as(a), request: del(body) }))
      .rejects.toMatchObject({ status: 400 });
  }
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/routes/api/app/watchlist/server.test.ts`
Expected: FAIL — `Failed to resolve import "./+server"`.

- [ ] **Step 3: Write the shared removal**

The chat tool `watchlistRemove` has the same bug the screen is fixing — it drops only the caller's
row and queues nothing, so the title is re-imported on the next poll. Two surfaces removing titles
with different semantics is worse than one broken surface, so both call one implementation.

Create `src/lib/server/consumer/watchlist-remove.ts`:

```ts
import type { DB } from '../db';
import { removeWatchlist } from './watchlist';
import { enqueueHouseholdRemoval } from './household-removals';
import { getStremioConnection, participantIds } from './household-stremio';
import { mirrorFavorite } from './jellyfin-favorite';

/**
 * Remove a title from the watchlist, household-aware. The single implementation behind both the
 * REST endpoint and the `watchlistRemove` chat tool — two surfaces with different removal
 * semantics would be worse than one.
 *
 * Household scope: the shared list belongs to the participants, so a participant's removal applies
 * to all of them and is queued for a Stremio tombstone. A non-participant (an invite with no
 * access to the household account) owns a private list; their removal is purely local and must
 * never touch anyone else's rows.
 */
export async function removeWatchlistEverywhere(
  db: DB, v: { actorId: number; tmdbId: number; mediaType: string }
): Promise<{ removed: boolean; household: boolean }> {
  const mediaType = v.mediaType === 'tv' ? 'tv' : 'movie';
  const conn = getStremioConnection(db);
  const participants = conn ? participantIds(db, conn) : [];
  const household = participants.includes(v.actorId);
  const targets = household ? participants : [v.actorId];

  const removed: Array<{ consumerId: number; jellyfinItemId: string | null }> = [];
  db.transaction(() => {
    for (const consumerId of targets) {
      const row = removeWatchlist(db, consumerId, v.tmdbId, mediaType);
      if (row) removed.push({ consumerId, jellyfinItemId: row.jellyfinItemId });
    }
    // Only queue a tombstone for a title the household actually held. Queuing one for a title
    // nobody had would push `removed: true` for an id the Library may never have seen.
    if (household && removed.length > 0) {
      enqueueHouseholdRemoval(db, { tmdbId: v.tmdbId, mediaType });
    }
  })();

  // Outside the transaction: these are network calls, and better-sqlite3 transactions are
  // synchronous. Per participant, because Jellyfin favourites are per-user.
  for (const r of removed) {
    if (r.jellyfinItemId) {
      await mirrorFavorite(db, r.consumerId, v.tmdbId, mediaType, false).catch(() => { /* best-effort */ });
    }
  }

  return { removed: removed.length > 0, household: household && removed.length > 0 };
}
```

Then rewrite the `watchlistRemove` tool in `src/lib/server/agent/tools.ts` (currently at ~line 337)
to delegate, replacing its `removeWatchlist` + `mirrorFavorite` body:

```ts
      async run(ctx, args) {
        const tmdbId = Number(args.tmdbId);
        const mediaType = args.mediaType === 'tv' ? 'tv' : 'movie';
        // Shared with the REST endpoint: household-aware, and queues the Stremio tombstone so the
        // title is not re-imported on the next poll.
        const r = await removeWatchlistEverywhere(ctx.db, { actorId: consumerId, tmdbId, mediaType });
        return scrub({ ok: r.removed, household: r.household });
      }
```

Import `removeWatchlistEverywhere` from `../consumer/watchlist-remove`, and drop the now-unused
`removeWatchlist` import if nothing else in the file uses it (check `watchlistAdd` first — it uses
`addWatchlist`, not `removeWatchlist`).

Add to `src/lib/server/agent/tools.test.ts` a test that the tool removes for every participant and
queues one `household_removals` row, mirroring the endpoint test.

- [ ] **Step 4: Write the endpoint**

Create `src/routes/api/app/watchlist/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listWatchlist } from '$lib/server/consumer/watchlist';
import { removeWatchlistEverywhere } from '$lib/server/consumer/watchlist-remove';
import { getConsumer, effectiveAllowList } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';
import type { DB } from '$lib/server/db';

/**
 * Gate on the EXISTING `watchlist` capability. No other REST endpoint under /api/app checks a
 * capability today — gating has lived only in the agent tool layer — but the same operations are
 * already governed by this capability through chat, so leaving REST ungated would make the
 * capability a fiction.
 */
function requireWatchlist(db: DB, consumerId: number): void {
  const c = getConsumer(db, consumerId);
  if (!c) throw error(401, 'Unauthorized');
  const role = getRole(db, c.roleId);
  if (!role || !effectiveAllowList(c, role).includes('watchlist')) throw error(403, 'Forbidden');
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  requireWatchlist(db, locals.consumer.id);
  // Project consumerId away — it is an internal id and the viewer only ever sees their own rows.
  return json(listWatchlist(db, locals.consumer.id).map((r) => ({
    id: r.id, tmdbId: r.tmdbId, mediaType: r.mediaType, title: r.title,
    onServer: r.onServer, notifyOnAvailable: r.notifyOnAvailable, addedAt: r.addedAt
  })));
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  requireWatchlist(db, locals.consumer.id);

  let body: any;
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const tmdbId = Number(body?.tmdbId);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) throw error(400, 'tmdbId required');
  const mediaType = body?.mediaType === 'tv' ? 'tv' : 'movie';

  const r = await removeWatchlistEverywhere(db, { actorId: locals.consumer.id, tmdbId, mediaType });
  return json({ ok: r.removed, household: r.household });
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/routes/api/app/watchlist/server.test.ts src/lib/server/agent/tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/app/watchlist src/lib/server/consumer/watchlist-remove.ts src/lib/server/agent/tools.ts src/lib/server/agent/tools.test.ts
git commit -m "feat: consumer watchlist api with shared household removal"
```

---

### Task 4: The screen

**Files:**
- Modify: `src/routes/app/requests/+page.svelte`
- Modify: `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json`
- Test: `e2e/watchlist.spec.ts`

**Interfaces:**
- Consumes from Task 3: `GET /api/app/watchlist`, `DELETE /api/app/watchlist`.

**Playwright gotcha that WILL bite you:** `src/service-worker.ts` re-issues every same-origin GET from inside the service worker, so `page.route()` GET mocks silently never fire (POST/DELETE are unaffected, which makes it look like half your mocks work). Create the context with `browser.newContext({ serviceWorkers: 'block' })`. Confine that to your spec; do NOT change the app's service worker.

- [ ] **Step 1: Add the i18n keys**

Add to the `app` object in `src/lib/i18n/en.json`:

```json
"navRequestsTab": "Requests",
"navWatchlistTab": "Watchlist",
"watchlistTitle": "Saved & requested",
"watchlistEmptyTitle": "Nothing saved yet.",
"watchlistEmptyCta": "Find something to watch",
"watchlistOnServer": "On the server",
"watchlistWanted": "Waiting for it",
"watchlistRemove": "Remove",
"watchlistRemoveConfirm": "Remove for everyone?",
"watchlistRemoveCancel": "Keep it",
"watchlistRemoveFailed": "Couldn't remove that. Try again in a moment.",
"watchlistSharedNote": "This list is shared with everyone on the household Stremio account — removing a title removes it for all of them, and takes it off the TV."
```

And the same keys in `src/lib/i18n/pt-BR.json`:

```json
"navRequestsTab": "Pedidos",
"navWatchlistTab": "Minha lista",
"watchlistTitle": "Salvos e pedidos",
"watchlistEmptyTitle": "Nada salvo ainda.",
"watchlistEmptyCta": "Achar algo para assistir",
"watchlistOnServer": "No servidor",
"watchlistWanted": "Esperando",
"watchlistRemove": "Remover",
"watchlistRemoveConfirm": "Remover para todo mundo?",
"watchlistRemoveCancel": "Deixar",
"watchlistRemoveFailed": "Não deu para remover. Tente de novo em instantes.",
"watchlistSharedNote": "Esta lista é compartilhada com todo mundo na conta do Stremio da casa — remover um título tira da lista de todos e some da TV."
```

- [ ] **Step 2: Write the failing e2e spec**

Create `e2e/watchlist.spec.ts`. Copy the admin-setup and consumer-onboarding helpers verbatim from `e2e/connections.spec.ts` (`setupAndLogin`, `ensureConnections`, `newConsumer`) rather than inventing them, then:

```ts
test('watchlist view lists saved titles and removing one confirms first', async ({ page, browser }) => {
  // The service worker re-issues same-origin GETs, which silently defeats page.route() GET mocks.
  const context = await browser.newContext({ serviceWorkers: 'block' });
  // ... admin setup + consumer login on `cp` (a page in `context`), as connections.spec.ts does

  let rows = [
    { id: 1, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true, addedAt: 2 },
    { id: 2, tmdbId: 238, mediaType: 'movie', title: 'Godfather', onServer: true, notifyOnAvailable: false, addedAt: 1 }
  ];
  await cp.route('**/api/app/watchlist', async (route) => {
    if (route.request().method() === 'DELETE') {
      rows = rows.filter((r) => r.tmdbId !== JSON.parse(route.request().postData() ?? '{}').tmdbId);
      return route.fulfill({ json: { ok: true, household: true } });
    }
    return route.fulfill({ json: rows });
  });
  await cp.route('**/api/app/detail*', (route) => route.fulfill({ json: {} }));

  await cp.goto('/app/requests');
  await cp.getByRole('tab', { name: 'Watchlist' }).click();
  await expect(cp.getByText('Shawshank')).toBeVisible();
  await expect(cp.getByText('Godfather')).toBeVisible();

  // First click asks; the row is still there.
  await cp.getByRole('button', { name: 'Remove' }).first().click();
  await expect(cp.getByText('Shawshank')).toBeVisible();
  // Confirming removes it.
  await cp.getByRole('button', { name: 'Remove for everyone?' }).click();
  await expect(cp.getByText('Shawshank')).toHaveCount(0);
  await expect(cp.getByText('Godfather')).toBeVisible();

  await context.close();
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx playwright test e2e/watchlist.spec.ts`
Expected: FAIL — there is no Watchlist tab.

- [ ] **Step 4: Build the view**

In `src/routes/app/requests/+page.svelte`:

Add to the `<script>` block, after the existing `details` state:

```ts
  type WatchlistRow = {
    id: number; tmdbId: number; mediaType: string; title: string;
    onServer: boolean; notifyOnAvailable: boolean; addedAt: number;
  };

  let view = $state<'requests' | 'watchlist'>('requests');
  let watchlist = $state<WatchlistRow[] | null>(null);
  let confirmingId = $state<number | null>(null);
  let removeErr = $state<string | null>(null);

  async function loadWatchlist() {
    const r = await fetch('/api/app/watchlist');
    if (r.status === 401) { await goto('/app/login'); return; }
    if (!r.ok) { watchlist = []; return; }
    watchlist = await r.json();
    for (const w of watchlist ?? []) hydrate(w);
  }

  async function removeFromWatchlist(w: WatchlistRow) {
    removeErr = null;
    const res = await fetch('/api/app/watchlist', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: w.tmdbId, mediaType: w.mediaType })
    });
    if (!res.ok) { removeErr = $_('app.watchlistRemoveFailed'); return; }
    confirmingId = null;
    await loadWatchlist();
  }

  function showView(v: 'requests' | 'watchlist') {
    view = v;
    confirmingId = null;
    if (v === 'watchlist' && watchlist === null) void loadWatchlist();
  }
```

`hydrate` and `detailFor` currently take a `ConsumerRequest`. Widen both to accept anything carrying `tmdbId` and `mediaType` — they only ever read those two fields:

```ts
  type Hydratable = { tmdbId: number; mediaType: string };
  async function hydrate(x: Hydratable) { /* body unchanged */ }
  function detailFor(x: Hydratable): DiscoverDetail | undefined { /* body unchanged */ }
```

Replace the `<h1>` with a tablist and wrap the existing list in the requests branch:

```svelte
  <div class="tabs" role="tablist">
    <button role="tab" class="tab" class:on={view === 'requests'}
      aria-selected={view === 'requests'} onclick={() => showView('requests')}
    >{$_('app.navRequestsTab')}</button>
    <button role="tab" class="tab" class:on={view === 'watchlist'}
      aria-selected={view === 'watchlist'} onclick={() => showView('watchlist')}
    >{$_('app.navWatchlistTab')}</button>
  </div>

  {#if view === 'requests'}
    <!-- the existing {#if requests && requests.length} … {:else if requests} block, unchanged -->
  {:else}
    <p class="shared-note">{$_('app.watchlistSharedNote')}</p>
    {#if removeErr}<p class="err">{removeErr}</p>{/if}
    {#if watchlist && watchlist.length}
      <ul class="cards">
        {#each watchlist as w (w.id)}
          {@const d = detailFor(w)}
          <li class="card">
            <button class="card-btn" type="button" onclick={() => (selected = {
              source: 'seerr', title: w.title, year: d?.year, poster: d?.poster,
              tmdbId: w.tmdbId, mediaType: w.mediaType, onServer: w.onServer,
              watchUrl: d?.watchUrl, released: true, requested: false
            } as DiscoverItem)}>
              <span class="poster">
                {#if d?.poster}
                  <img src={d.poster} alt={w.title} loading="lazy" />
                {:else}
                  <span class="poster-fallback" aria-hidden="true">
                    {w.mediaType === 'tv' ? $_('app.tagSeries') : $_('app.tagMovie')}
                  </span>
                {/if}
              </span>
              <span class="meta">
                <span class="title">{w.title}</span>
                {#if d?.year}<span class="year">{d.year}</span>{/if}
                <span class="badge" data-tone={w.onServer ? 'available' : 'pending'}>
                  {w.onServer ? $_('app.watchlistOnServer') : $_('app.watchlistWanted')}
                </span>
              </span>
            </button>
            {#if confirmingId === w.id}
              <button class="rm confirm" type="button" onclick={() => removeFromWatchlist(w)}
              >{$_('app.watchlistRemoveConfirm')}</button>
              <button class="rm" type="button" onclick={() => (confirmingId = null)}
              >{$_('app.watchlistRemoveCancel')}</button>
            {:else}
              <button class="rm" type="button" onclick={() => (confirmingId = w.id)}
              >{$_('app.watchlistRemove')}</button>
            {/if}
          </li>
        {/each}
      </ul>
    {:else if watchlist}
      <div class="empty">
        <p class="empty-title">{$_('app.watchlistEmptyTitle')}</p>
        <a class="empty-cta" href="/app/discover">{$_('app.watchlistEmptyCta')} ▸</a>
      </div>
    {/if}
  {/if}
```

Update `<svelte:head>` so the title follows the view:

```svelte
<svelte:head><title>{view === 'watchlist' ? $_('app.watchlistTitle') : $_('app.requestsTitle')} · Pulse</title></svelte:head>
```

Append to the existing `<style>` block:

```css
  .tabs { display: flex; gap: 0.4rem; margin: 0 0 1.1rem; }
  .tab {
    flex: 1; padding: 0.55rem 0.8rem; border-radius: 12px; font-size: 0.9rem; font-weight: 600;
    background: var(--card, rgba(255, 255, 255, 0.04));
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    color: var(--sub, #9aa4b2); cursor: pointer;
  }
  .tab.on {
    color: #08110d;
    background: linear-gradient(135deg, var(--accent, #28e0a0), var(--accent2, #36c6ff));
    border-color: transparent;
  }
  .shared-note { font-size: 0.78rem; color: var(--sub, #9aa4b2); margin: 0 0 0.9rem; line-height: 1.45; }
  .err { font-size: 0.82rem; color: #ff7a92; margin: 0 0 0.7rem; }
  .rm {
    flex-shrink: 0; padding: 0.4rem 0.7rem; border-radius: 10px; font-size: 0.78rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--card-brd, rgba(255, 255, 255, 0.08));
    color: var(--sub, #9aa4b2); cursor: pointer;
  }
  .rm.confirm { color: #ff7a92; border-color: color-mix(in srgb, #ff7a92 40%, transparent); }
```

- [ ] **Step 5: Verify**

Run: `npm test && npm run check && npx playwright test e2e/watchlist.spec.ts`
Expected: all PASS, `dictionaries.test.ts` included.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: watchlist view on the requests page"
```

---

## Self-Review

**Spec coverage.**

| Spec section | Task |
|---|---|
| `household_removals` table, `CREATE TABLE IF NOT EXISTS` | 1 |
| imdb id resolved at enqueue time, nullable | 1 |
| Transaction: delete every participant's row + enqueue one | 3 |
| Push `removed: true`, read-modify-write preserving `state` | 2 |
| Exclude queued ids from the reconciler's input | 2 |
| Clear the queue only after `datastorePut` succeeds | 2 |
| Failed write → rows survive, title still not re-imported | 2 |
| Non-participant / no connection → local only | 3 |
| `stremio-reconcile.ts` untouched | 2 (Step 4 gate) |
| Flat list, newest first | 3 (`listWatchlist` already orders `added_at DESC`), 4 |
| Second view on Requests, not a sixth nav tab | 4 |
| Posters hydrated lazily via `/api/app/detail` | 4 |
| Single inline confirm | 4 |
| `GET`/`DELETE` gated on consumer + `watchlist` capability | 3 |
| `consumerId` projected away | 3 |
| `mirrorFavorite` parity with the chat tool | 3 (one shared implementation, so parity is structural rather than duplicated) |

**Placeholder scan.** None — every code step carries its code, every test step its assertions. The one "copy from a neighbouring file" instruction (the e2e setup helpers) names the exact file.

**Type consistency.** `enqueueHouseholdRemoval`/`listHouseholdRemovals`/`clearHouseholdRemovals` are defined in Task 1 and used with matching signatures in Tasks 2 and 3. `WatchlistRow` in Task 4 matches the `GET` projection in Task 3 field-for-field. `hydrate`/`detailFor` are widened in Task 4 to accept both `ConsumerRequest` and `WatchlistRow`, which is required because both views use them.

## Known gaps, deliberately not addressed

- The 8 `tmdb:`-keyed Library items still cannot be resolved by Cinemeta and so never import. Unrelated to removal.
