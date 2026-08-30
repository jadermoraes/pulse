# Stremio Addon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a Stremio addon from pulse that lets the household browse and play the Jellyfin library inside Stremio, and request a missing title by selecting a stream entry.

**Architecture:** One catch-all route under the unused `/api/_public` auth hatch, addressed by a token in the path, dispatching to small testable modules under `src/lib/server/addon/`. The addon declares `catalog` and `stream` only — items are keyed by IMDb id and Cinemeta supplies metadata, which removes the `meta` resource and the whole season/episode metadata tree. Video is proxied through pulse with `Range` forwarding so the Jellyfin key never leaves the server.

**Tech Stack:** SvelteKit 2 + Svelte 5 runes, TypeScript, better-sqlite3, zod 4, vitest, Playwright, svelte-i18n.

**Spec:** `docs/superpowers/specs/2026-08-30-stremio-addon-design.md`

## Global Constraints

- **`migrate()` in `src/lib/server/db.ts` has no `ALTER` path and is uncaught in `getDb()`** — a throwing statement stops the app booting. New schema is `CREATE TABLE IF NOT EXISTS` only. `migrate()`'s body is ONE JS template literal: escape any backtick inside a SQL comment as `` \` `` or it closes the literal and breaks parsing.
- **`/api/_public/**` is exempt from every auth gate in `hooks.server.ts` and nothing else uses it.** The handler owns 100% of its own auth. Do NOT add it to `isPublicHostAllowed` — the addon is LAN-only by design, and the 404 on `PULSE_PUBLIC_HOST` is the mechanism.
- **The Jellyfin API key must never appear in a response body, a redirect, a log line, or a URL handed to a client.**
- **An invalid, unknown, or revoked token returns 404, never 401** — the addon must be invisible rather than confirm that valid tokens exist.
- **`foreign_keys = ON`.** `migrate()` auto-seeds an Admin role at id=1, so fixtures use role id=2 and seed `roles` before `consumer_users`.
- **Tests must never open the real `pulse.sqlite`** — `openDb(':memory:')` + `migrate(db)`.
- **Vocabulary:** Stremio says `movie`/`series`; pulse and Seerr say `movie`/`tv`; `imdb_meta_cache.media_type` says `movie`/`series`. `stremioType()` in `consumer/stremio-reconcile.ts` is the existing translator. Never mix them.
- **Every user-visible string goes through svelte-i18n and must exist in BOTH `src/lib/i18n/en.json` and `src/lib/i18n/pt-BR.json`.** `dictionaries.test.ts` fails on any asymmetry or empty value. pt-BR copy is direct, never corporate-cutesy.
- **No assistant attribution in commit messages.** Plain messages only.
- Verify with `npm test`, `npm run check` (must stay **0 errors AND 0 warnings**), and `npx playwright test e2e/<file>` (`npm run e2e -- <name>` does NOT filter). `e2e/accounts.spec.ts:98` fails on master too — ignore it.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/server/db.ts` | **Modify** — add `addon_tokens`. |
| `src/lib/server/addon/tokens.ts` | **Create** — mint / resolve / touch / revoke / read the household token. |
| `src/lib/server/addon/jellyfin-library.ts` | **Create** — the only file that talks to Jellyfin: list, search, find-by-imdb, find-episode, build the upstream stream URL. |
| `src/lib/server/addon/manifest.ts` | **Create** — the manifest object. |
| `src/lib/server/addon/catalog.ts` | **Create** — library items → Stremio meta previews; extras parsing. |
| `src/lib/server/addon/stream.ts` | **Create** — id parsing and the stream list (play entry vs request entry). |
| `src/routes/api/_public/addon/[token]/[...resource]/+server.ts` | **Create** — the thin dispatcher, plus the `play` proxy and `request` action. |
| `src/routes/api/addon/+server.ts` | **Create** — admin GET/POST/DELETE to read, mint and revoke the token. |
| `src/routes/settings/+page.svelte` | **Modify** — the admin panel. |
| `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json` | **Modify** — admin panel strings. |
| `static/addon/requested.mp4` | **Already committed** (`5d0007a`) — 13KB, 4s, baseline H.264, faststart. Do not regenerate. Served by adapter-node at `/addon/requested.mp4`; never read it off disk. |
| `e2e/addon.spec.ts` | **Create** — admin mints a token, addon serves a manifest. |

---

### Task 1: `addon_tokens` and the token module

**Files:**
- Modify: `src/lib/server/db.ts` (after `household_removals`)
- Create: `src/lib/server/addon/tokens.ts`
- Test: `src/lib/server/addon/tokens.test.ts`

**Interfaces produced** (Tasks 3-7 consume these):
- `mintAddonToken(db, { consumerId, label }): string` — revokes any existing live token first; one household token at a time.
- `resolveAddonToken(db, token): { token: string; consumerId: number } | null` — null for unknown, malformed or revoked.
- `touchAddonToken(db, token): void`
- `revokeAddonToken(db): void`
- `readAddonToken(db): { token: string; consumerId: number; label: string | null; createdAt: number; lastUsedAt: number | null } | null` — the live token, for the admin panel.

- [ ] **Step 1: Add the table**

In `src/lib/server/db.ts`, immediately after the `household_removals` table, add:

```sql
    -- Bearer token for the inbound Stremio ADDON (catalog + playback + request). Unrelated to the
    -- outbound Library sync, whose credential lives in `connections`. It sits in a URL path, so it
    -- is a bearer credential: it grants read of the whole library catalogue, streaming of any item,
    -- and requesting as one consumer. ON DELETE CASCADE means deleting that consumer revokes the
    -- addon, which is the correct failure direction.
    CREATE TABLE IF NOT EXISTS addon_tokens (
      token        TEXT PRIMARY KEY,
      consumer_id  INTEGER NOT NULL REFERENCES consumer_users(id) ON DELETE CASCADE,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at   INTEGER
    );
```

- [ ] **Step 2: Write the failing tests**

Create `src/lib/server/addon/tokens.test.ts`:

```ts
import { it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  mintAddonToken, resolveAddonToken, touchAddonToken, revokeAddonToken, readAddonToken
} from './tokens';

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

it('mints a high-entropy hex token', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(t).toMatch(/^[0-9a-f]{48}$/);
});

it('resolves a live token to its consumer', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(resolveAddonToken(db, t)).toEqual({ token: t, consumerId: a });
});

it('returns null for unknown, empty and malformed tokens', () => {
  mintAddonToken(db, { consumerId: a, label: 'TV' });
  for (const bad of ['', 'nope', 'x'.repeat(48), '../../etc/passwd', "' OR 1=1 --"]) {
    expect(resolveAddonToken(db, bad)).toBeNull();
  }
});

it('returns null once revoked', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  revokeAddonToken(db);
  expect(resolveAddonToken(db, t)).toBeNull();
  expect(readAddonToken(db)).toBeNull();
});

it('minting again revokes the previous token', () => {
  const first = mintAddonToken(db, { consumerId: a, label: 'TV' });
  const second = mintAddonToken(db, { consumerId: b, label: 'PC' });
  expect(second).not.toBe(first);
  // The old URL must stop working the moment a new one is minted, or a leaked token survives
  // a "regenerate".
  expect(resolveAddonToken(db, first)).toBeNull();
  expect(resolveAddonToken(db, second)).toEqual({ token: second, consumerId: b });
  expect(readAddonToken(db)!.token).toBe(second);
});

it('touch records last use without changing anything else', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  expect(readAddonToken(db)!.lastUsedAt).toBeNull();
  touchAddonToken(db, t);
  const r = readAddonToken(db)!;
  expect(r.lastUsedAt).toEqual(expect.any(Number));
  expect(r.consumerId).toBe(a);
  expect(r.label).toBe('TV');
});

it('deleting the attributed consumer revokes the token', () => {
  const t = mintAddonToken(db, { consumerId: a, label: 'TV' });
  db.prepare('DELETE FROM consumer_users WHERE id=?').run(a);
  expect(resolveAddonToken(db, t)).toBeNull();
  expect(readAddonToken(db)).toBeNull();
});

it('is a no-op rather than a throw when nothing is minted', () => {
  expect(() => { revokeAddonToken(db); touchAddonToken(db, 'whatever'); }).not.toThrow();
  expect(readAddonToken(db)).toBeNull();
});
```

- [ ] **Step 3: Run and watch it fail**

Run: `npx vitest run src/lib/server/addon/tokens.test.ts`
Expected: FAIL — `Failed to resolve import "./tokens"`.

- [ ] **Step 4: Write the module**

Create `src/lib/server/addon/tokens.ts`:

```ts
import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

export interface AddonToken {
  token: string;
  consumerId: number;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Mint the household addon token, revoking any previous one.
 *
 * There is deliberately at most ONE live token. A "regenerate" must invalidate the old URL —
 * otherwise a leaked token keeps working forever and regenerating is security theatre.
 */
export function mintAddonToken(db: DB, v: { consumerId: number; label?: string | null }): string {
  const token = randomBytes(24).toString('hex'); // 48 hex chars, matching invites/password-reset
  db.transaction(() => {
    db.prepare('UPDATE addon_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
    db.prepare(
      'INSERT INTO addon_tokens(token,consumer_id,label,created_at) VALUES (?,?,?,?)'
    ).run(token, v.consumerId, v.label ?? null, Date.now());
  })();
  return token;
}

/** Null for unknown, malformed or revoked. Callers turn null into a 404, never a 401. */
export function resolveAddonToken(db: DB, token: string): { token: string; consumerId: number } | null {
  // Shape-check before touching the DB: the token arrives from a URL path, so reject anything that
  // is not exactly what mint produces rather than handing arbitrary text to a query.
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const r = db.prepare(
    'SELECT token, consumer_id FROM addon_tokens WHERE token = ? AND revoked_at IS NULL'
  ).get(token) as { token: string; consumer_id: number } | undefined;
  return r ? { token: r.token, consumerId: r.consumer_id } : null;
}

export function touchAddonToken(db: DB, token: string): void {
  db.prepare('UPDATE addon_tokens SET last_used_at = ? WHERE token = ? AND revoked_at IS NULL')
    .run(Date.now(), token);
}

export function revokeAddonToken(db: DB): void {
  db.prepare('UPDATE addon_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
}

export function readAddonToken(db: DB): AddonToken | null {
  const r = db.prepare(
    'SELECT token, consumer_id, label, created_at, last_used_at FROM addon_tokens WHERE revoked_at IS NULL'
  ).get() as any;
  return r ? {
    token: r.token, consumerId: r.consumer_id, label: r.label ?? null,
    createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null
  } : null;
}
```

- [ ] **Step 5: Verify**

Run: `npx vitest run src/lib/server/addon/tokens.test.ts src/lib/server/db.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/server/db.ts src/lib/server/addon/tokens.ts src/lib/server/addon/tokens.test.ts
git commit -m "feat: stremio addon token store"
```

---

### Task 2: The Jellyfin library module

**Files:**
- Create: `src/lib/server/addon/jellyfin-library.ts`
- Test: `src/lib/server/addon/jellyfin-library.test.ts`

This is the ONLY file in the addon that talks to Jellyfin. Everything else works on its return
types, which is what makes the rest unit-testable without HTTP.

**Interfaces produced:**
- `type LibraryItem = { jellyfinId: string; imdbId: string; type: 'movie' | 'series'; name: string; year: number | null; posterTag: string | null }`
- `listLibrary(conn, o: { type: 'movie'|'series'; skip: number; limit: number; search?: string }): Promise<LibraryItem[]>`
- `findByImdb(conn, imdbId: string, type: 'movie'|'series'): Promise<LibraryItem | null>`
- `findEpisode(conn, seriesJellyfinId: string, season: number, episode: number): Promise<string | null>` — the episode's Jellyfin id.
- `upstreamStreamUrl(conn, jellyfinItemId: string): string | null` — the Jellyfin URL pulse's proxy fetches, or `null` when the connection's `baseUrl` cannot be parsed. **Server-side only; never returned to a client.**

(There is deliberately no `posterUrl` here — Task 3's `toMetaPreviews` and Task 5's poster branch build that URL inline from `origin` + `token`, so a helper would have one caller and one shape.)

- [ ] **Step 1: Write the failing tests**

Create `src/lib/server/addon/jellyfin-library.test.ts`. Stub `global.fetch` and assert on the URLs
built, since a wrong query parameter is the most likely defect and is invisible otherwise.

```ts
import { it, expect, afterEach, vi } from 'vitest';
import {
  listLibrary, findByImdb, findEpisode, upstreamStreamUrl, type LibraryItem
} from './jellyfin-library';
import type { Connection } from '../connections';

const conn = {
  id: 1, type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096/', secret: 'KEY',
  options: {}, enabled: true
} as Connection;

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

function stub(payload: unknown): string[] {
  const urls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    urls.push(String(url));
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as any);
  return urls;
}

const ITEM = {
  Id: 'jf-1', Name: 'Shawshank', ProductionYear: 1994,
  ProviderIds: { Imdb: 'tt0111161', Tmdb: '278' },
  ImageTags: { Primary: 'tag1' }, Type: 'Movie'
};

it('lists movies with paging, and never leaks the api key into the returned items', async () => {
  const urls = stub({ Items: [ITEM] });
  const out = await listLibrary(conn, { type: 'movie', skip: 40, limit: 20 });
  expect(urls[0]).toContain('/Items');
  expect(urls[0]).toContain('IncludeItemTypes=Movie');
  expect(urls[0]).toContain('Recursive=true');
  expect(urls[0]).toContain('StartIndex=40');
  expect(urls[0]).toContain('Limit=20');
  expect(urls[0]).toContain('Fields=ProviderIds%2CProductionYear');
  expect(out).toEqual([{
    jellyfinId: 'jf-1', imdbId: 'tt0111161', type: 'movie',
    name: 'Shawshank', year: 1994, posterTag: 'tag1'
  }]);
  expect(JSON.stringify(out)).not.toContain('KEY');
});

it('maps the series type to Jellyfin Series, not Movie', async () => {
  const urls = stub({ Items: [] });
  await listLibrary(conn, { type: 'series', skip: 0, limit: 10 });
  expect(urls[0]).toContain('IncludeItemTypes=Series');
  expect(urls[0]).not.toContain('IncludeItemTypes=Movie');
});

it('passes a search term through as SearchTerm', async () => {
  const urls = stub({ Items: [] });
  await listLibrary(conn, { type: 'movie', skip: 0, limit: 10, search: 'blade runner' });
  expect(urls[0]).toContain('SearchTerm=blade+runner');
});

it('drops items with no imdb id rather than inventing one', async () => {
  stub({ Items: [ITEM, { Id: 'jf-2', Name: 'Homemade', ProviderIds: { Tmdb: '9' }, Type: 'Movie' }] });
  const out = await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  // Cinemeta supplies metadata by imdb id; an item without one would render as an empty page.
  expect(out.map((i) => i.jellyfinId)).toEqual(['jf-1']);
});

it('tolerates a missing ProviderIds/ImageTags/ProductionYear without throwing', async () => {
  stub({ Items: [{ Id: 'jf-3', Name: 'Bare', ProviderIds: { Imdb: 'tt9' }, Type: 'Movie' }] });
  const out = await listLibrary(conn, { type: 'movie', skip: 0, limit: 10 });
  expect(out[0]).toMatchObject({ jellyfinId: 'jf-3', year: null, posterTag: null });
});

it('returns an empty list rather than throwing when Jellyfin is unreachable', async () => {
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('returns an empty list on a non-2xx', async () => {
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  await expect(listLibrary(conn, { type: 'movie', skip: 0, limit: 10 })).resolves.toEqual([]);
});

it('finds a movie by imdb id in one call', async () => {
  const urls = stub({ Items: [ITEM] });
  const out = await findByImdb(conn, 'tt0111161', 'movie');
  expect(urls[0]).toContain('AnyProviderIdEquals=imdb.tt0111161');
  expect(urls[0]).toContain('IncludeItemTypes=Movie');
  expect(out!.jellyfinId).toBe('jf-1');
});

it('returns null when the library does not have the title', async () => {
  stub({ Items: [] });
  expect(await findByImdb(conn, 'tt0000000', 'movie')).toBeNull();
});

it('rejects an imdb id that is not tt-shaped rather than querying', async () => {
  const urls = stub({ Items: [ITEM] });
  // The id arrives from a URL path. A crafted value must not reach the upstream query string.
  for (const bad of ['', 'nope', 'tt', '../x', 'tt1&Foo=bar']) {
    expect(await findByImdb(conn, bad, 'movie')).toBeNull();
  }
  expect(urls).toEqual([]);
});

it('finds an episode by season and episode number', async () => {
  const urls = stub({ Items: [
    { Id: 'ep-1', ParentIndexNumber: 1, IndexNumber: 1 },
    { Id: 'ep-2', ParentIndexNumber: 1, IndexNumber: 2 },
    { Id: 'ep-3', ParentIndexNumber: 2, IndexNumber: 2 }
  ] });
  expect(await findEpisode(conn, 'series-1', 1, 2)).toBe('ep-2');
  expect(urls[0]).toContain('/Shows/series-1/Episodes');
  expect(urls[0]).toContain('season=1');
});

it('returns null for an episode the series does not have', async () => {
  stub({ Items: [{ Id: 'ep-1', ParentIndexNumber: 1, IndexNumber: 1 }] });
  expect(await findEpisode(conn, 'series-1', 1, 99)).toBeNull();
});

it('does not confuse the same episode number in a different season', async () => {
  stub({ Items: [
    { Id: 'ep-s1', ParentIndexNumber: 1, IndexNumber: 5 },
    { Id: 'ep-s2', ParentIndexNumber: 2, IndexNumber: 5 }
  ] });
  expect(await findEpisode(conn, 'series-1', 2, 5)).toBe('ep-s2');
});

it('builds an upstream stream url carrying the api key', () => {
  const u = upstreamStreamUrl(conn, 'jf-1');
  expect(u).toBe('http://jf:8096/Videos/jf-1/stream?static=true&api_key=KEY');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/lib/server/addon/jellyfin-library.test.ts`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the module**

Create `src/lib/server/addon/jellyfin-library.ts`:

```ts
import type { Connection } from '../connections';

export interface LibraryItem {
  jellyfinId: string;
  imdbId: string;
  type: 'movie' | 'series';
  name: string;
  year: number | null;
  posterTag: string | null;
}

/** Jellyfin authenticates by query parameter (see integrations/jellyfin.ts). */
function jf(conn: Connection, path: string, query: Record<string, string> = {}): string {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  u.searchParams.set('api_key', conn.secret ?? '');
  return u.toString();
}

/**
 * Every Jellyfin call in the addon goes through here. Jellyfin being down must degrade to an empty
 * catalogue and no streams — never a 500 — because Stremio surfaces an addon error as a broken row
 * with no explanation, which is worse than an empty one.
 */
async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

const IMDB_RE = /^tt\d+$/;

function toItem(raw: any, type: 'movie' | 'series'): LibraryItem | null {
  const imdbId = raw?.ProviderIds?.Imdb ?? raw?.ProviderIds?.IMDB ?? null;
  // No imdb id means Cinemeta cannot describe it, so it would render as an empty detail page.
  // Dropping it is better than surfacing an item nothing can explain.
  if (!imdbId || !IMDB_RE.test(imdbId) || !raw?.Id || !raw?.Name) return null;
  return {
    jellyfinId: String(raw.Id),
    imdbId,
    type,
    name: String(raw.Name),
    year: typeof raw.ProductionYear === 'number' ? raw.ProductionYear : null,
    posterTag: raw?.ImageTags?.Primary ?? null
  };
}

const JF_TYPE = { movie: 'Movie', series: 'Series' } as const;

export async function listLibrary(
  conn: Connection,
  o: { type: 'movie' | 'series'; skip: number; limit: number; search?: string }
): Promise<LibraryItem[]> {
  const query: Record<string, string> = {
    Recursive: 'true',
    IncludeItemTypes: JF_TYPE[o.type],
    Fields: 'ProviderIds,ProductionYear',
    SortBy: o.search ? 'SortName' : 'DateCreated',
    SortOrder: o.search ? 'Ascending' : 'Descending',
    StartIndex: String(Math.max(0, o.skip)),
    Limit: String(Math.max(1, Math.min(200, o.limit)))
  };
  if (o.search) query.SearchTerm = o.search;
  const data = await getJson(jf(conn, '/Items', query));
  const items: any[] = Array.isArray(data?.Items) ? data.Items : [];
  return items.map((i) => toItem(i, o.type)).filter((i): i is LibraryItem => i !== null);
}

export async function findByImdb(
  conn: Connection, imdbId: string, type: 'movie' | 'series'
): Promise<LibraryItem | null> {
  // The id comes straight from a URL path. Shape-check before it reaches an upstream query string.
  if (!IMDB_RE.test(imdbId)) return null;
  const data = await getJson(jf(conn, '/Items', {
    Recursive: 'true',
    IncludeItemTypes: JF_TYPE[type],
    Fields: 'ProviderIds,ProductionYear',
    AnyProviderIdEquals: `imdb.${imdbId}`,
    Limit: '1'
  }));
  const raw = Array.isArray(data?.Items) ? data.Items[0] : null;
  return raw ? toItem(raw, type) : null;
}

export async function findEpisode(
  conn: Connection, seriesJellyfinId: string, season: number, episode: number
): Promise<string | null> {
  const data = await getJson(jf(conn, `/Shows/${encodeURIComponent(seriesJellyfinId)}/Episodes`, {
    season: String(season),
    Fields: 'ProviderIds'
  }));
  const items: any[] = Array.isArray(data?.Items) ? data.Items : [];
  // Match on BOTH numbers: `season=` is a hint Jellyfin does not always honour strictly, and
  // episode 5 of season 1 and of season 2 must never be confused.
  const hit = items.find((i) => i?.ParentIndexNumber === season && i?.IndexNumber === episode);
  return hit?.Id ? String(hit.Id) : null;
}

/** SERVER-SIDE ONLY. Carries the api key — never return this to a client. */
export function upstreamStreamUrl(conn: Connection, jellyfinItemId: string): string {
  return jf(conn, `/Videos/${encodeURIComponent(jellyfinItemId)}/stream`, { static: 'true' });
}
```

Note the parameter order in `upstreamStreamUrl`: the test expects `?static=true&api_key=KEY`, and
`jf()` appends `api_key` last, so that ordering holds.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/lib/server/addon/jellyfin-library.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/addon/jellyfin-library.ts src/lib/server/addon/jellyfin-library.test.ts
git commit -m "feat: jellyfin library queries for the stremio addon"
```

---

### Task 3: Manifest, catalog and stream builders

**Files:**
- Create: `src/lib/server/addon/manifest.ts`, `src/lib/server/addon/catalog.ts`, `src/lib/server/addon/stream.ts`
- Test: `src/lib/server/addon/catalog.test.ts`, `src/lib/server/addon/stream.test.ts`

Pure functions over Task 2's return types — no HTTP, no DB. This is where the protocol shape is
pinned.

**Interfaces produced:**
- `buildManifest(): object`
- `parseExtras(raw: string | undefined): { search?: string; skip: number }`
- `toMetaPreviews(items: LibraryItem[], origin: string, token: string): object[]`
- `parseStreamId(raw: string): { imdbId: string; season: number | null; episode: number | null } | null`
- `buildPlayStream(origin, token, jellyfinItemId, name): object`
- `buildRequestStream(origin, token, type, id): object`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/server/addon/catalog.test.ts`:

```ts
import { it, expect } from 'vitest';
import { buildManifest, parseExtras, toMetaPreviews } from './catalog';
import type { LibraryItem } from './jellyfin-library';

const item: LibraryItem = {
  jellyfinId: 'jf-1', imdbId: 'tt0111161', type: 'movie',
  name: 'Shawshank', year: 1994, posterTag: 'tag1'
};

it('the manifest declares catalog and stream but NOT meta', () => {
  const m = buildManifest() as any;
  // Omitting `meta` is deliberate: items are keyed by imdb id and Cinemeta, installed by default,
  // supplies the detail page. Declaring meta would make pulse responsible for season trees it
  // does not model.
  expect(m.resources).toEqual(['catalog', 'stream']);
  expect(m.types).toEqual(['movie', 'series']);
  expect(m.idPrefixes).toEqual(['tt']);
  expect(m.id).toMatch(/^[a-z0-9.]+$/);
  expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(m.catalogs.map((c: any) => [c.type, c.id])).toEqual([
    ['movie', 'pulse-movies'], ['series', 'pulse-series']
  ]);
  // Both catalogs must advertise search and skip or Stremio never sends them.
  for (const c of m.catalogs) {
    const names = c.extra.map((e: any) => e.name).sort();
    expect(names).toEqual(['search', 'skip']);
  }
});

it('parses extras from the path segment', () => {
  expect(parseExtras('search=blade%20runner&skip=100')).toEqual({ search: 'blade runner', skip: 100 });
  expect(parseExtras('skip=20')).toEqual({ skip: 20 });
  expect(parseExtras(undefined)).toEqual({ skip: 0 });
  expect(parseExtras('')).toEqual({ skip: 0 });
});

it('clamps a hostile or nonsense skip instead of passing it upstream', () => {
  expect(parseExtras('skip=-5').skip).toBe(0);
  expect(parseExtras('skip=abc').skip).toBe(0);
  expect(parseExtras('skip=999999999').skip).toBeLessThanOrEqual(100000);
});

it('ignores an empty search rather than sending SearchTerm=', () => {
  expect(parseExtras('search=').search).toBeUndefined();
  expect(parseExtras('search=%20%20').search).toBeUndefined();
});

it('maps library items to meta previews keyed by imdb id', () => {
  const [m] = toMetaPreviews([item], 'http://pulse:3000', 'tok') as any[];
  expect(m.id).toBe('tt0111161');
  expect(m.type).toBe('movie');
  expect(m.name).toBe('Shawshank');
  expect(m.releaseInfo).toBe('1994');
  expect(m.poster).toBe('http://pulse:3000/api/_public/addon/tok/poster/jf-1/tag1');
});

it('omits the poster when the item has no primary image, rather than emitting a broken url', () => {
  const [m] = toMetaPreviews([{ ...item, posterTag: null }], 'http://pulse:3000', 'tok') as any[];
  expect(m.poster).toBeUndefined();
});

it('omits releaseInfo when the year is unknown', () => {
  const [m] = toMetaPreviews([{ ...item, year: null }], 'http://pulse:3000', 'tok') as any[];
  expect(m.releaseInfo).toBeUndefined();
});
```

Create `src/lib/server/addon/stream.test.ts`:

```ts
import { it, expect } from 'vitest';
import { parseStreamId, buildPlayStream, buildRequestStream } from './stream';

it('parses a movie id', () => {
  expect(parseStreamId('tt0111161')).toEqual({ imdbId: 'tt0111161', season: null, episode: null });
});

it('parses an episode id', () => {
  // Stremio addresses episodes as tt<id>:<season>:<episode>. This format is convention rather
  // than documented, and is the first thing to verify against a real client.
  expect(parseStreamId('tt0903747:2:7')).toEqual({ imdbId: 'tt0903747', season: 2, episode: 7 });
});

it('rejects anything that is not a tt id or tt:S:E', () => {
  for (const bad of ['', 'nope', 'tt', 'tt1:2', 'tt1:2:3:4', 'tt1:a:2', '../etc', 'tt1 2']) {
    expect(parseStreamId(bad)).toBeNull();
  }
});

it('rejects a negative or zero season/episode', () => {
  expect(parseStreamId('tt1:0:1')).toBeNull();
  expect(parseStreamId('tt1:1:0')).toBeNull();
  expect(parseStreamId('tt1:-1:1')).toBeNull();
});

it('builds a play stream pointing at pulse, never at jellyfin', () => {
  const s = buildPlayStream('http://pulse:3000', 'tok', 'jf-1', 'Shawshank') as any;
  expect(s.url).toBe('http://pulse:3000/api/_public/addon/tok/play/jf-1');
  // notWebReady because the proxy is plain http on the LAN and the container may not be mp4.
  expect(s.behaviorHints.notWebReady).toBe(true);
  expect(JSON.stringify(s)).not.toContain('api_key');
});

it('builds a request stream that names what it will do', () => {
  const s = buildRequestStream('http://pulse:3000', 'tok', 'movie', 'tt1') as any;
  expect(s.url).toBe('http://pulse:3000/api/_public/addon/tok/request/movie/tt1');
  expect(s.name).toBeTruthy();
  // The viewer's only signal is this text; it must say that selecting it requests the title.
  expect(String(s.description ?? s.title ?? '').toLowerCase()).toContain('request');
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/lib/server/addon/catalog.test.ts src/lib/server/addon/stream.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 3: Write the modules**

Create `src/lib/server/addon/catalog.ts`:

```ts
import type { LibraryItem } from './jellyfin-library';

export const CATALOG_IDS = { movie: 'pulse-movies', series: 'pulse-series' } as const;
const MAX_SKIP = 100000;

/**
 * `meta` is deliberately absent from `resources`. Items are keyed by imdb id, and Cinemeta —
 * installed by default in every Stremio — serves the detail page for a `tt` id. Declaring `meta`
 * would make pulse responsible for season/episode metadata trees it models nowhere.
 */
export function buildManifest(): Record<string, unknown> {
  const extra = [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }];
  return {
    id: 'com.pulse.jellyfin',
    version: '1.0.0',
    name: 'Pulse',
    description: 'Your Jellyfin library, and a way to ask pulse for what is missing.',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      { type: 'movie', id: CATALOG_IDS.movie, name: 'Pulse — Movies', extra },
      { type: 'series', id: CATALOG_IDS.series, name: 'Pulse — Series', extra }
    ],
    behaviorHints: { configurable: false, configurationRequired: false }
  };
}

/** Extras arrive as a query string stringified into one path segment. */
export function parseExtras(raw: string | undefined): { search?: string; skip: number } {
  const p = new URLSearchParams(raw ?? '');
  const rawSkip = Number(p.get('skip'));
  const skip = Number.isFinite(rawSkip) && rawSkip > 0 ? Math.min(Math.floor(rawSkip), MAX_SKIP) : 0;
  const search = (p.get('search') ?? '').trim();
  return search ? { search, skip } : { skip };
}

export function toMetaPreviews(
  items: LibraryItem[], origin: string, token: string
): Array<Record<string, unknown>> {
  return items.map((i) => {
    const meta: Record<string, unknown> = { id: i.imdbId, type: i.type, name: i.name };
    if (i.year !== null) meta.releaseInfo = String(i.year);
    // Posters go through pulse for the same reason streams do: the Jellyfin key stays server-side.
    if (i.posterTag) {
      meta.poster = `${origin}/api/_public/addon/${token}/poster/${i.jellyfinId}/${i.posterTag}`;
    }
    return meta;
  });
}
```

Create `src/lib/server/addon/stream.ts`:

```ts
const ID_RE = /^(tt\d+)(?::(\d+):(\d+))?$/;

export function parseStreamId(
  raw: string
): { imdbId: string; season: number | null; episode: number | null } | null {
  const m = ID_RE.exec(raw);
  if (!m) return null;
  if (m[2] === undefined) return { imdbId: m[1], season: null, episode: null };
  const season = Number(m[2]);
  const episode = Number(m[3]);
  // Season and episode are 1-based; 0 or negative is malformed, not a real address.
  if (season < 1 || episode < 1) return null;
  return { imdbId: m[1], season, episode };
}

export function buildPlayStream(
  origin: string, token: string, jellyfinItemId: string, name: string
): Record<string, unknown> {
  return {
    url: `${origin}/api/_public/addon/${token}/play/${jellyfinItemId}`,
    name: 'Pulse',
    description: `Play ${name} from your library`,
    behaviorHints: {
      // The proxy is plain http on the LAN and the container is whatever Jellyfin holds, so the
      // client must not assume a web-ready mp4 over https.
      notWebReady: true
    }
  };
}

export function buildRequestStream(
  origin: string, token: string, type: string, id: string
): Record<string, unknown> {
  return {
    url: `${origin}/api/_public/addon/${token}/request/${type}/${id}`,
    name: 'Pulse',
    description: 'Not in your library — select to request it on pulse',
    behaviorHints: { notWebReady: true }
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run src/lib/server/addon/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/addon/manifest.ts src/lib/server/addon/catalog.ts src/lib/server/addon/stream.ts src/lib/server/addon/catalog.test.ts src/lib/server/addon/stream.test.ts
git commit -m "feat: stremio addon manifest, catalog and stream builders"
```

(There is no separate `manifest.ts` — `buildManifest` lives in `catalog.ts`. Drop it from the
`git add` if you did not create it.)

---

### Task 4: The dispatcher route — manifest, catalog, stream, poster

**Files:**
- Create: `src/routes/api/_public/addon/[token]/[...resource]/+server.ts`
- Test: `src/routes/api/_public/addon/[token]/[...resource]/server.test.ts`

One catch-all rather than a route per resource: the protocol puts a `.json` suffix and an embedded
query string into path segments, which SvelteKit's matcher handles badly. The handler stays thin
and delegates to Tasks 1-3.

`play` and `request` are added in Task 5; this task returns 404 for them.

- [ ] **Step 1: Write the failing tests**

Create the test file. Mock `getDb` the way `src/routes/api/stremio/server.test.ts` does.

```ts
import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { mintAddonToken, readAddonToken } from '$lib/server/addon/tokens';
import { createConnection } from '$lib/server/connections';

let db: DB;
let consumerId: number;

vi.mock('$lib/server/db', async (orig) => {
  const real = await orig<typeof import('$lib/server/db')>();
  return { ...real, getDb: () => db };
});

beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('INSERT INTO roles(id,name,created_at) VALUES (2,?,?)').run('viewer', Date.now());
  consumerId = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (2,'Jader','active',?)"
  ).run(Date.now()).lastInsertRowid);
  createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf:8096', secret: 'KEY', options: {} });
});
const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; vi.restoreAllMocks(); });

const call = (token: string, resource: string, origin = 'http://pulse:3000') =>
  ({ params: { token, resource }, url: new URL(`${origin}/api/_public/addon/${token}/${resource}`),
     getClientAddress: () => '10.0.0.5' }) as any;

function stubJf(payload: unknown) {
  global.fetch = (vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as any);
}

it('404s an unknown, revoked or malformed token — never 401', async () => {
  mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  for (const bad of ['deadbeef', '', 'x'.repeat(48), '../../etc']) {
    const res = await (GET as any)(call(bad, 'manifest.json'));
    // 401 would confirm that valid tokens exist. The addon must be invisible.
    expect(res.status).toBe(404);
  }
});

it('serves the manifest for a live token', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'manifest.json'));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.resources).toEqual(['catalog', 'stream']);
  expect(res.headers.get('content-type')).toContain('application/json');
});

it('records last use', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'manifest.json'));
  expect(readAddonToken(db)!.lastUsedAt).toEqual(expect.any(Number));
});

it('serves a catalog', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'Shawshank', ProductionYear: 1994,
    ProviderIds: { Imdb: 'tt0111161' }, ImageTags: { Primary: 'tag1' } }] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'))).json();
  expect(body.metas).toHaveLength(1);
  expect(body.metas[0].id).toBe('tt0111161');
});

it('passes search and skip through from the extras segment', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  global.fetch = (vi.fn(async (u: any) => {
    urls.push(String(u));
    return new Response(JSON.stringify({ Items: [] }), { status: 200 });
  }) as any);
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'catalog/movie/pulse-movies/search=blade%20runner&skip=40.json'));
  expect(urls[0]).toContain('SearchTerm=blade+runner');
  expect(urls[0]).toContain('StartIndex=40');
});

it('404s an unknown catalog id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'catalog/movie/someone-elses.json'))).status).toBe(404);
});

it('returns an empty catalog rather than a 500 when jellyfin is down', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).metas).toEqual([]);
});

it('returns a play stream for a title in the library', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [{ Id: 'jf-1', Name: 'Shawshank', ProviderIds: { Imdb: 'tt0111161' } }] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/tt0111161.json'))).json();
  expect(body.streams).toHaveLength(1);
  expect(body.streams[0].url).toBe(`http://pulse:3000/api/_public/addon/${t}/play/jf-1`);
  // The key must never reach the client.
  expect(JSON.stringify(body)).not.toContain('KEY');
  expect(JSON.stringify(body)).not.toContain('api_key');
});

it('returns a request stream for a title NOT in the library', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubJf({ Items: [] });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/tt0000000.json'))).json();
  expect(body.streams).toHaveLength(1);
  expect(body.streams[0].url).toContain(`/addon/${t}/request/movie/tt0000000`);
});

it('resolves an episode to its own jellyfin id, not the series', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  let call_ = 0;
  global.fetch = (vi.fn(async () => {
    call_++;
    if (call_ === 1) return new Response(JSON.stringify({ Items: [
      { Id: 'series-1', Name: 'Breaking Bad', ProviderIds: { Imdb: 'tt0903747' } } ] }), { status: 200 });
    return new Response(JSON.stringify({ Items: [
      { Id: 'ep-7', ParentIndexNumber: 2, IndexNumber: 7 } ] }), { status: 200 });
  }) as any);
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/series/tt0903747:2:7.json'))).json();
  expect(body.streams[0].url).toContain('/play/ep-7');
});

it('offers no stream at all for a malformed id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const body = await (await (GET as any)(call(t, 'stream/movie/not-an-id.json'))).json();
  expect(body.streams).toEqual([]);
});

it('404s when no jellyfin connection is configured', async () => {
  db.prepare("DELETE FROM connections WHERE type='jellyfin'").run();
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'catalog/movie/pulse-movies.json'));
  expect(res.status).toBe(200);
  expect((await res.json()).metas).toEqual([]);
});

it('404s an unknown resource', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'subtitles/movie/tt1.json'))).status).toBe(404);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `npx vitest run src/routes/api/_public/addon/`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write the dispatcher**

Create `src/routes/api/_public/addon/[token]/[...resource]/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections, type Connection } from '$lib/server/connections';
import { resolveAddonToken, touchAddonToken } from '$lib/server/addon/tokens';
import { buildManifest, parseExtras, toMetaPreviews, CATALOG_IDS } from '$lib/server/addon/catalog';
import { parseStreamId, buildPlayStream, buildRequestStream } from '$lib/server/addon/stream';
import { listLibrary, findByImdb, findEpisode } from '$lib/server/addon/jellyfin-library';

const PAGE = 100;

/** Everything unknown, unauthorised or unsupported answers the same way: 404, no body. */
function notFound(): Response {
  return new Response(null, { status: 404 });
}

/** Stremio caches aggressively; a short TTL keeps a freshly-added title from being invisible. */
function jsonRes(body: unknown): Response {
  return json(body, { headers: { 'Cache-Control': 'public, max-age=60' } });
}

function jellyfinConn(db: ReturnType<typeof getDb>): Connection | null {
  return listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled) ?? null;
}

function stremioType(t: string): 'movie' | 'series' | null {
  return t === 'movie' ? 'movie' : t === 'series' ? 'series' : null;
}

export const GET: RequestHandler = async ({ params, url }) => {
  const db = getDb();
  const token = String(params.token ?? '');
  const auth = resolveAddonToken(db, token);
  // 404 not 401: a 401 would confirm that valid tokens exist for this path.
  if (!auth) return notFound();
  touchAddonToken(db, token);

  const parts = String(params.resource ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return notFound();
  const origin = url.origin;

  if (parts.length === 1 && parts[0] === 'manifest.json') {
    return jsonRes(buildManifest());
  }

  const conn = jellyfinConn(db);

  // catalog/<type>/<id>.json  |  catalog/<type>/<id>/<extras>.json
  if (parts[0] === 'catalog' && (parts.length === 3 || parts.length === 4)) {
    const type = stremioType(parts[1]);
    if (!type) return notFound();
    const catalogId = parts.length === 3 ? parts[2].replace(/\.json$/, '') : parts[2];
    if (catalogId !== CATALOG_IDS[type]) return notFound();
    // Jellyfin unreachable or unconfigured degrades to an empty row, never an error: Stremio
    // shows an addon error as a broken row with no explanation.
    if (!conn) return jsonRes({ metas: [] });
    const extras = parseExtras(parts.length === 4 ? parts[3].replace(/\.json$/, '') : undefined);
    const items = await listLibrary(conn, { type, skip: extras.skip, limit: PAGE, search: extras.search });
    return jsonRes({ metas: toMetaPreviews(items, origin, token) });
  }

  // stream/<type>/<id>.json
  if (parts[0] === 'stream' && parts.length === 3) {
    const type = stremioType(parts[1]);
    if (!type) return notFound();
    const parsed = parseStreamId(decodeURIComponent(parts[2].replace(/\.json$/, '')));
    if (!parsed) return jsonRes({ streams: [] });
    if (!conn) return jsonRes({ streams: [] });

    const found = await findByImdb(conn, parsed.imdbId, type);
    if (!found) {
      // Not in the library at all — offer the request action instead of nothing.
      return jsonRes({
        streams: [buildRequestStream(origin, token, type, parts[2].replace(/\.json$/, ''))]
      });
    }

    let playId: string | null = found.jellyfinId;
    if (parsed.season !== null && parsed.episode !== null) {
      // A series' own item id is not playable — resolve the episode.
      playId = await findEpisode(conn, found.jellyfinId, parsed.season, parsed.episode);
    }
    if (!playId) return jsonRes({ streams: [] });
    return jsonRes({ streams: [buildPlayStream(origin, token, playId, found.name)] });
  }

  return notFound();
};
```

- [ ] **Step 4: Verify**

Run: `npx vitest run src/routes/api/_public/addon/ && npm run check`
Expected: PASS, 0 errors 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/_public/addon
git commit -m "feat: stremio addon manifest, catalog and stream endpoints"
```

---

### Task 5: The play proxy, the poster proxy and the request action

**Files:**
- Modify: `src/routes/api/_public/addon/[token]/[...resource]/+server.ts`
- Modify: `src/routes/api/_public/addon/[token]/[...resource]/server.test.ts`

**Two things carry the risk in this task.** First, `Range` handling — without a correct `206` and
`Content-Range`, playback either fails outright or cannot seek. Second, this route is still
unauthenticated: `safeDecode` (added in Task 4) must be used for every path segment you decode,
because `decodeURIComponent` throws a `URIError` on a malformed escape and a throw here is a 500
from a public URL.

**The original wording, kept because it is still true:** Without a correct `206` and
`Content-Range`, playback either fails outright or cannot seek.

- [ ] **Step 1: Write the failing tests**

Append:

```ts
function stubUpstream(handler: (url: string, init: any) => Response) {
  global.fetch = (vi.fn(async (u: any, init: any) => handler(String(u), init)) as any);
}

it('play proxies the bytes and never reveals the upstream url or key', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  stubUpstream(() => new Response('VIDEOBYTES', {
    status: 200, headers: { 'Content-Type': 'video/mp4', 'Content-Length': '10', 'Accept-Ranges': 'bytes' }
  }));
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'play/jf-1'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('video/mp4');
  expect(res.headers.get('accept-ranges')).toBe('bytes');
  expect(await res.text()).toBe('VIDEOBYTES');
});

it('CRITICAL: play forwards the Range header and returns 206 with Content-Range', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  let sawRange: string | null = null;
  stubUpstream((_u, init) => {
    sawRange = new Headers(init?.headers).get('range');
    return new Response('BYTES', {
      status: 206,
      headers: { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 100-104/1000', 'Content-Length': '5' }
    });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)({
    ...call(t, 'play/jf-1'),
    request: new Request('http://pulse:3000/x', { headers: { Range: 'bytes=100-104' } })
  });
  // Without this, seeking is impossible and some clients refuse to play at all.
  expect(sawRange).toBe('bytes=100-104');
  expect(res.status).toBe(206);
  expect(res.headers.get('content-range')).toBe('bytes 100-104/1000');
});

it('play rejects an item id that is not a plain jellyfin id', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('x', { status: 200 }); });
  const { GET } = await import('./+server');
  // SSRF guard: a crafted id must never reach the upstream fetch.
  for (const bad of ['../../etc/passwd', 'http://evil/x', 'jf-1?api_key=stolen', 'jf 1']) {
    expect((await (GET as any)(call(t, `play/${bad}`))).status).toBe(404);
  }
  expect(urls).toEqual([]);
});

it('play 404s rather than 500s when jellyfin is unreachable', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  global.fetch = (vi.fn(async () => { throw new TypeError('fetch failed'); }) as any);
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'play/jf-1'))).status).toBe(404);
});

it('request creates a request for the token consumer and plays the clip', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  db.prepare('UPDATE consumer_users SET seerr_user_id = 7 WHERE id = ?').run(consumerId);
  stubUpstream((u) => {
    if (u.includes('/api/v1/request')) return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  const res = await (GET as any)(call(t, 'request/movie/tt0111161'));
  // 302 to the static clip: production has no `static/` dir (the image copies only `build/`), so
  // reading the file off disk would throw there while passing here.
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('http://pulse:3000/addon/requested.mp4');
  const rows = db.prepare('SELECT * FROM consumer_requests WHERE consumer_id=?').all(consumerId);
  expect(rows).toHaveLength(1);
});

it('CRITICAL: selecting request twice does not stack duplicate requests', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  db.prepare('UPDATE consumer_users SET seerr_user_id = 7 WHERE id = ?').run(consumerId);
  let posts = 0;
  stubUpstream((u) => {
    if (u.includes('/api/v1/request')) { posts++; return new Response(JSON.stringify({ id: 1 }), { status: 200 }); }
    return new Response(JSON.stringify({ title: 'Shawshank' }), { status: 200 });
  });
  const { GET } = await import('./+server');
  await (GET as any)(call(t, 'request/movie/tt0111161'));
  const second = await (GET as any)(call(t, 'request/movie/tt0111161'));
  // Selecting a stream is cheap and repeatable; the request must not be.
  expect(posts).toBe(1);
  expect(second.status).toBe(302);  // still plays the clip
  expect(db.prepare('SELECT COUNT(*) c FROM consumer_requests').get()).toEqual({ c: 1 });
});

it('request still plays the clip when seerr rejects it', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  db.prepare('UPDATE consumer_users SET seerr_user_id = 7 WHERE id = ?').run(consumerId);
  stubUpstream(() => new Response('no', { status: 500 }));
  const { GET } = await import('./+server');
  // The viewer has no channel to read an error in — failing loudly only yields a broken video icon.
  const res = await (GET as any)(call(t, 'request/movie/tt0111161'));
  expect(res.status).toBe(302);
});

it('request 404s a malformed id without touching seerr', async () => {
  const t = mintAddonToken(db, { consumerId, label: 'TV' });
  const urls: string[] = [];
  stubUpstream((u) => { urls.push(u); return new Response('{}', { status: 200 }); });
  const { GET } = await import('./+server');
  expect((await (GET as any)(call(t, 'request/movie/not-an-id'))).status).toBe(404);
  expect(urls).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run src/routes/api/_public/addon/`
Expected: FAIL — `play` and `request` currently return 404.

- [ ] **Step 3: Implement**

Add to the dispatcher, before the final `return notFound()`. Add these imports:

```ts
import { upstreamStreamUrl } from '$lib/server/addon/jellyfin-library';
import { resolveImdbMeta } from '$lib/server/integrations/cinemeta';
import { getConsumer } from '$lib/server/identity/consumers';
import { createConsumerRequest } from '$lib/server/consumer/requests';
import { logAccess } from '$lib/server/identity/access-log';
```

The handler signature needs `request` and `getClientAddress`:

```ts
export const GET: RequestHandler = async ({ params, url, request, getClientAddress }) => {
```

Then:

```ts
  // play/<jellyfinItemId>
  if (parts[0] === 'play' && parts.length === 2) {
    if (!conn) return notFound();
    const itemId = parts[1];
    // SSRF guard, same reasoning as the poster proxy: the id is caller-supplied and is
    // interpolated into an upstream URL. Accept only what a Jellyfin id can actually look like.
    if (!/^[A-Za-z0-9-]{1,64}$/.test(itemId)) return notFound();

    // `upstreamStreamUrl` returns null when the connection's baseUrl cannot be parsed (a value
    // saved without a scheme, e.g. `192.168.1.5:8096`). Treat it exactly like an unreachable
    // Jellyfin — a 404, never a throw.
    const target = upstreamStreamUrl(conn, itemId);
    if (!target) return notFound();

    const range = request.headers.get('range');
    let upstream: Response;
    try {
      upstream = await fetch(target, { headers: range ? { Range: range } : {} });
    } catch {
      return notFound();
    }
    if (!upstream.ok && upstream.status !== 206) return notFound();

    // Forward exactly the headers that make seeking work. Content-Range and Accept-Ranges are the
    // load-bearing pair: without them a player cannot seek, and some refuse to start at all.
    const headers = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    }
    if (!headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes');
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  // poster/<jellyfinItemId>/<tag>
  if (parts[0] === 'poster' && parts.length === 3) {
    if (!conn) return notFound();
    const [, itemId, tag] = parts;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(itemId) || !/^[A-Za-z0-9]{1,64}$/.test(tag)) return notFound();
    const target = `${conn.baseUrl.replace(/\/$/, '')}/Items/${itemId}/Images/Primary` +
      `?tag=${tag}&maxWidth=400&api_key=${encodeURIComponent(conn.secret ?? '')}`;
    let upstream: Response;
    try { upstream = await fetch(target); } catch { return notFound(); }
    if (!upstream.ok) return notFound();
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': upstream.headers.get('Content-Type') ?? 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  // request/<type>/<id>
  if (parts[0] === 'request' && parts.length === 3) {
    const type = stremioType(parts[1]);
    // Decode with the SAME safeDecode the stream branch uses, and validate the DECODED value.
    // Task 4's stream branch passes the still-encoded `rawId` into `buildRequestStream`, so the id
    // arriving here can be percent-escaped — validating the raw form would let an escape sequence
    // through that `parseStreamId` never saw. `decodeURIComponent` also throws on a malformed
    // escape like `%zz`, which on this unauthenticated route would be a 500.
    const parsed = type ? parseStreamId(safeDecode(parts[2])) : null;
    if (!type || !parsed) return notFound();

    const consumer = getConsumer(db, auth.consumerId);
    if (consumer) {
      const mediaType = type === 'series' ? 'tv' : 'movie';
      try {
        const meta = await resolveImdbMeta(db, parsed.imdbId, type);
        if (meta?.tmdbId != null) {
          // Selecting a stream is cheap and repeatable — a viewer may well click twice. Only the
          // first click may become a request.
          const existing = db.prepare(
            `SELECT 1 FROM consumer_requests
              WHERE consumer_id=? AND tmdb_id=? AND media_type=?
                AND status IN ('pending','approved','processing','available')`
          ).get(consumer.id, meta.tmdbId, mediaType);
          if (!existing) {
            await createConsumerRequest(db, consumer, { tmdbId: meta.tmdbId, mediaType });
            logAccess(db, {
              consumerId: consumer.id, type: 'request', detail: `${meta.name} (stremio addon)`,
              ip: getClientAddress()
            });
          }
        }
      } catch {
        // The viewer's only channel is the video that plays next; a thrown error would surface as
        // a broken-media icon with no explanation. Swallow and still play the confirmation.
      }
    }

    // Redirect to the static clip rather than reading it off disk. In production there is NO
    // `static/` directory: the Dockerfile copies only `build/`, and adapter-node serves static
    // assets from `build/client/`, so `readFile('static/…')` resolves against CWD `/app` and
    // throws — passing every local test and silently playing nothing on the server. adapter-node
    // already serves this file at `/addon/requested.mp4` with the right type and Range support.
    return new Response(null, {
      status: 302,
      headers: { Location: `${origin}/addon/requested.mp4` }
    });
  }
```

**Why a redirect and not `readFile`:** verified against the running container — the Dockerfile
copies only `/app/build`, there is no `/app/static`, and adapter-node serves static assets out of
`build/client/`. Any relative `readFile('static/…')` resolves against CWD `/app` and throws, which
this handler would swallow into a 404 — green tests locally, nothing playing in production. Do not
"optimise" the redirect away.

- [ ] **Step 4: Verify**

Run: `npx vitest run src/routes/api/_public/addon/ && npm run check`
Expected: PASS, 0 errors 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/routes/api/_public/addon
git commit -m "feat: stremio addon playback proxy, poster proxy and request action"
```

---

### Task 6: Admin API and panel

**Files:**
- Create: `src/routes/api/addon/+server.ts`, `src/routes/api/addon/server.test.ts`
- Modify: `src/routes/settings/+page.svelte`, `src/lib/i18n/en.json`, `src/lib/i18n/pt-BR.json`
- Test: `e2e/addon.spec.ts`

**Endpoints** (admin-gated by `hooks.server.ts` plus an in-handler `locals.user` check, matching `/api/stremio`):
- `GET /api/addon` → `{ linked, token, consumerId, label, createdAt, lastUsedAt, consumers: [{id, displayName}] }`
- `POST /api/addon` `{ consumerId, label? }` → `{ ok: true, token }`
- `DELETE /api/addon` → `{ ok: true }`

- [ ] **Step 1: Write the failing tests**

Mirror `src/routes/api/stremio/server.test.ts`. Cover: 401 without `locals.user` on all three verbs;
GET returns the roster and null state when unminted; POST mints and returns the token; POST with a
consumerId that is not a real consumer 400s; POST twice invalidates the first token; DELETE revokes.

- [ ] **Step 2: Write the endpoint**

Follow `src/routes/api/stremio/+server.ts` exactly for shape: a `requireAdmin(locals)` helper
throwing 401, `getDb()`, explicit field projection. Validate `consumerId` against `listConsumers`
before minting — a token pointing at a non-existent consumer would 404 forever with no explanation.

- [ ] **Step 3: Add the i18n keys**

Add to the `settings` object in BOTH dictionaries. en:

```json
"addon": {
  "title": "Stremio addon",
  "description": "Browse and play your Jellyfin library inside Stremio, and request what's missing. Install the URL below in Stremio on the TV or the PC.",
  "notMinted": "No addon URL yet.",
  "attributedTo": "Requests are made as",
  "label": "Name this install (optional)",
  "labelPlaceholder": "Living room TV",
  "generate": "Generate URL",
  "regenerate": "Generate a new URL",
  "regenerateWarning": "The old URL stops working immediately.",
  "revoke": "Revoke",
  "copy": "Copy",
  "copied": "Copied.",
  "lastUsed": "Last used {when}",
  "neverUsed": "never used",
  "lanOnly": "This URL only works on your local network.",
  "tokenWarning": "Anyone with this URL can browse and play your whole library, and request titles as the chosen user. Treat it like a password.",
  "failed": "Something went wrong. Try again."
}
```

pt-BR, direct wording:

```json
"addon": {
  "title": "Addon do Stremio",
  "description": "Veja e assista sua biblioteca do Jellyfin dentro do Stremio, e peça o que não tem. Instale a URL abaixo no Stremio da TV ou do PC.",
  "notMinted": "Ainda não tem URL.",
  "attributedTo": "Os pedidos entram como",
  "label": "Nome desta instalação (opcional)",
  "labelPlaceholder": "TV da sala",
  "generate": "Gerar URL",
  "regenerate": "Gerar uma URL nova",
  "regenerateWarning": "A URL antiga para de funcionar na hora.",
  "revoke": "Revogar",
  "copy": "Copiar",
  "copied": "Copiado.",
  "lastUsed": "Usado pela última vez {when}",
  "neverUsed": "nunca usado",
  "lanOnly": "Esta URL só funciona na sua rede local.",
  "tokenWarning": "Quem tiver esta URL pode ver e assistir toda a sua biblioteca, e pedir títulos como o usuário escolhido. Trate como uma senha.",
  "failed": "Deu algum problema. Tente de novo."
}
```

- [ ] **Step 4: Add the panel**

In `src/routes/settings/+page.svelte`, add a second `<section class="hh-card">` immediately after
the household Stremio panel, inside the `{#if activeTab === 'connections'}` block. Reuse the same
state/loader shape as the Stremio panel. It must show:

- the full install URL, built as `${location.origin}/api/_public/addon/${token}/manifest.json`,
  in a read-only input with a Copy button;
- `settings.addon.tokenWarning` and `settings.addon.lanOnly` prominently — this is a bearer
  credential and the panel is the only place that says so;
- a consumer `<select>` for attribution;
- `lastUsed`, Generate/Regenerate, and Revoke;
- `settings.addon.regenerateWarning` next to Regenerate when a token already exists.

Load it from the same unconditional `void loadAddon();` in `onMount` as the Stremio panel.

- [ ] **Step 5: e2e**

Create `e2e/addon.spec.ts`. Copy the admin login helper from `e2e/connections.spec.ts`. Mock
`/api/addon` (GET/POST/DELETE) with `browser.newContext({ serviceWorkers: 'block' })` — the service
worker re-issues same-origin GETs and silently defeats `page.route()` GET mocks. Drive: no URL →
generate → URL visible → revoke → back to no URL.

- [ ] **Step 6: Verify**

Run: `npm test && npm run check && npx playwright test e2e/addon.spec.ts`
Expected: all PASS, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: stremio addon admin panel"
```

---

## Self-Review

**Spec coverage.**

| Spec item | Task |
|---|---|
| `catalog` + `stream` only, no `meta` | 3 (asserted in the manifest test) |
| Items keyed by imdb id; no-imdb items dropped | 2 |
| Video proxied, key server-side | 2 (`upstreamStreamUrl` server-only), 5 (proxy) |
| `Range` forwarded, 206 + `Content-Range` | 5 |
| One household token in the URL path | 1 |
| Requests attributed to a nominated consumer | 1, 5 |
| Request-on-select, idempotent | 5 |
| Routes under `/api/_public`, LAN-only | 4 (and NOT added to `isPublicHostAllowed`) |
| 404 not 401 for a bad token | 1, 4 |
| Jellyfin down → empty catalog, not 500 | 2, 4 |
| Episode resolution `tt:S:E` | 2, 3, 4 |
| Admin mint/revoke/attribute + last-used | 6 |
| Token risk stated to the admin | 6 (`tokenWarning`) |

**Placeholder scan.** Task 6's steps 1, 2, 4 and 5 describe rather than transcribe, deliberately:
each is "mirror this named existing file". Every other step carries its code. If the executor
cannot find the named prior art, that is a BLOCKED report, not a guess.

**Type consistency.** `LibraryItem` is produced by Task 2 and consumed unchanged by Tasks 3-5.
`resolveAddonToken` returns `{token, consumerId}` and every caller uses both. `parseStreamId`'s
`{imdbId, season, episode}` is consumed in Task 4's stream branch and Task 5's request branch.
`CATALOG_IDS` is defined in `catalog.ts` and imported by the dispatcher.

## Smoke gates — none of this is proven until a real client runs

1. **`tt1234:1:2` is convention, not documentation.** Install the addon, open a series, and check
   what Stremio actually requests. If the shape differs, only `parseStreamId` changes.
2. **Cinemeta meta fallback is an assumption.** If catalog items open to empty detail pages,
   add a `meta` resource backed by `jellyfin.detail`.
3. **Seeking.** Scrub a long file. If it snaps back to the start, `Content-Range` is not surviving.
4. **`notWebReady`.** If playback fails outright on the TV but works on the PC, revisit that hint
   and the container Jellyfin is serving.
