import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { buildLibraryItem, loadPulseItems, pollStremioSync, MAX_IMPORTS_PER_CYCLE } from './stremio-sync';
import { saveStremioConnection, setParticipants, readHousehold, getStremioConnection } from './household-stremio';
import { addWatchlist, listWatchlist } from './watchlist';
import { listHouseholdRemovals } from './household-removals';
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

/**
 * A LIVE stub: every datastorePut is applied back into the library, so the NEXT datastoreGet sees
 * what actually landed. A static fixture cannot reach the cycle-AFTER-the-tombstone paths at all,
 * which is exactly how the provenance bugs on this path hid from review.
 *
 * When ONE put body carries two documents for the same _id, Stremio's resolution is undefined, so
 * this models the damaging one: the tombstone wins regardless of order. Correct code never emits
 * two, making that moot. Across separate puts a later document simply replaces the earlier one —
 * that is a plain full-document replace, and it is how a revive reaches the TV.
 */
function stubStremioLive(initial: any[]): { library: any[]; puts: any[] } {
  const library: any[] = initial.map((i) => ({ ...i }));
  const puts: any[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: library.map((i) => ({ ...i })) }), { status: 200 });
    }
    if (u.endsWith('/datastorePut')) {
      const body = JSON.parse(String(init.body));
      puts.push(body);
      const inThisBody = new Set<string>();
      for (const c of body.changes) {
        // a tombstone written earlier IN THIS BODY wins over a later document for the same _id
        if (inThisBody.has(c._id)) continue;
        if (c.removed === true) inThisBody.add(c._id);
        const idx = library.findIndex((i) => i._id === c._id);
        if (idx < 0) { library.push({ ...c }); continue; }
        library[idx] = { ...c };
      }
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  return { library, puts };
}

it('buildLibraryItem copies the shape of an existing item rather than inventing one', () => {
  const template = {
    _id: 'tt999', name: 'Other', type: 'movie', poster: 'x.jpg', removed: false, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-01-01T00:00:00.000Z',
    state: { timeOffset: 42, watched: 'yes' },
    someUnknownField: 7, background: 'other-bg.jpg', year: 1994,
    behaviorHints: { defaultVideoId: 'x' }, links: [{ name: 'Drama' }]
  } as any;
  const item = buildLibraryItem(want, template, { name: 'Shawshank', poster: 'p.jpg' });
  expect(item._id).toBe('tt0111161');
  expect(item.type).toBe('movie');
  expect(item.removed).toBe(false);
  // The template's KEYS survive; none of its VALUES do. Asserting only that the key is present
  // (as this test used to) passes just as happily for an implementation that ships the other
  // movie's artwork, year and description under the new title's _id.
  expect(Object.keys(item)).toContain('someUnknownField');
  expect(item.someUnknownField).not.toBe(7);
  expect(item.someUnknownField).toBe(0);
  expect(item.background).toBeNull();
  expect(item.year).toBe(0);
  // objects and arrays must not come across by reference either
  expect(item.behaviorHints).toEqual({});
  expect(item.behaviorHints).not.toBe(template.behaviorHints);
  expect(item.links).toEqual([]);
  expect((item.state as any).timeOffset).toBe(0);
});

it('buildLibraryItem maps a tv row to the series type', () => {
  const item = buildLibraryItem({ ...want, mediaType: 'tv', imdbId: 'tt0903747' }, null, null);
  expect(item.type).toBe('series');
  expect(item._id).toBe('tt0903747');
});

it('pushes a wanted title into an empty stremio library', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    calls.push(String(url));
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  expect(calls.some((u) => u.endsWith('/datastorePut'))).toBe(true);
  expect(readHousehold(db)!.lastSyncAt).not.toBeNull();
});

it('pushes an in-flight request that is not on the watchlist', async () => {
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','pending',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);
  expect(putBody.changes.map((c: any) => c._id)).toEqual(['tt0111161']);
});

it('a failing spoke records the failure and never throws', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: true });
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  link([consumerId]);

  await expect(pollStremioSync(db)).resolves.toBeUndefined();
  expect(readHousehold(db)!.lastError).toBeTruthy();
});

it('a consumer with an empty watchlist and an empty library makes no put', async () => {
  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  }) as any);
  link([consumerId]);
  await pollStremioSync(db);
  expect(calls.some((u) => u.endsWith('/datastorePut'))).toBe(false);
});

// --- fix round 1 ---

it('CRITICAL: re-pushing a tombstoned item preserves its own progress instead of zeroing it', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  // pulse dropped this item on a previous cycle (title was on the server); the title has since
  // left the server again (onServer:false above) so the reconciler will re-push it.
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',278,'movie',?,?)`
  ).run(Date.now(), Date.now());

  const tombstoned = {
    _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'old.jpg', removed: true, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-06-01T00:00:00.000Z',
    state: { timeOffset: 4200, watched: 'yes' }
  };
  // An UNRELATED item sits at index 0 so `library[0]` (the naive fallback template) is NOT the
  // same object as `byId.get(p.imdbId)`. Its shape/state deliberately differ from `tombstoned`'s
  // (a different numeric offset, a different watched flag) so a regression that falls back to
  // `library[0]` instead of looking the id up would produce visibly wrong assertions below.
  const unrelated = {
    _id: 'tt0000001', name: 'Somebody Else', type: 'movie', poster: 'other.jpg', removed: false, temp: false,
    _ctime: '2021-01-01T00:00:00.000Z', _mtime: '2021-01-01T00:00:00.000Z',
    state: { timeOffset: 1, watched: 'no' }
  };

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [unrelated, tombstoned] }), { status: 200 });
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  const change = putBody.changes.find((c: any) => c._id === 'tt0111161');
  expect(change.removed).toBe(false);
  expect(change.state).toEqual({ timeOffset: 4200, watched: 'yes' });
  expect(change._ctime).toBe('2020-01-01T00:00:00.000Z');

  const st = db.prepare(
    `SELECT dropped_at FROM household_sync_state WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=278 AND media_type='movie'`
  ).get() as any;
  expect(st.dropped_at).toBeNull();
});

it('buildLibraryItem resets non-numeric progress fields too when borrowing an unrelated item shape', () => {
  const template = {
    _id: 'tt999', name: 'Other', type: 'movie', poster: 'x.jpg', removed: false, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-01-01T00:00:00.000Z',
    state: { timeOffset: 42, watched: 'yes', lastWatched: '2020-01-01T00:00:00.000Z', flagged: true }
  } as any;
  const item = buildLibraryItem(want, template, { name: 'Shawshank', poster: 'p.jpg' });
  expect((item.state as any).timeOffset).toBe(0);
  expect((item.state as any).watched).toBeNull();
  expect((item.state as any).lastWatched).toBeNull();
  expect((item.state as any).flagged).toBe(false);
});

it('five consecutive 5xx from stremio leave the credential enabled', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: true });
  global.fetch = (vi.fn(async () => new Response('nope', { status: 500 })) as any);
  link([consumerId]);

  for (let i = 0; i < 5; i++) await pollStremioSync(db);

  expect(getStremioConnection(db)!.enabled).toBe(true);
  expect(readHousehold(db)!.lastError).toBeTruthy();
});

it('an auth rejection disables the credential after MAX_FAILS', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: true });
  global.fetch = (vi.fn(async () =>
    new Response(JSON.stringify({ error: { code: 1, message: 'Invalid auth' } }), { status: 200 })
  ) as any);
  link([consumerId]);

  for (let i = 0; i < 5; i++) await pollStremioSync(db);

  expect(getStremioConnection(db)!.enabled).toBe(false);
});

it('an HTTP 401 from stremio disables the credential after MAX_FAILS, unlike a 500', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: true });
  global.fetch = (vi.fn(async () => new Response('unauthorized', { status: 401 })) as any);
  link([consumerId]);

  for (let i = 0; i < 5; i++) await pollStremioSync(db);

  expect(getStremioConnection(db)!.enabled).toBe(false);
});

it('loadPulseItems resolving an imdb id via Seerr does not poison a later Cinemeta lookup', async () => {
  addWatchlist(db, { consumerId, tmdbId: 999, mediaType: 'movie', title: 'New Title', onServer: false, notifyOnAvailable: true });
  const seerrId = createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr.local', secret: 'sk', options: {} });
  const seerr = getConnection(db, seerrId)!;

  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('seerr.local')) {
      return new Response(JSON.stringify({ externalIds: { imdbId: 'tt5555555' } }), { status: 200 });
    }
    if (u.includes('cinemeta')) {
      return new Response(JSON.stringify({
        meta: { imdb_id: 'tt5555555', id: 'tt5555555', moviedb_id: 999, name: 'Real Name', poster: 'real.jpg', type: 'movie' }
      }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as any);

  const items = await loadPulseItems(db, [consumerId], seerr);
  expect(items[0].imdbId).toBe('tt5555555');

  const meta = await resolveImdbMeta(db, 'tt5555555', 'movie');
  expect(meta?.name).toBe('Real Name');
  expect(meta?.poster).toBe('real.jpg');
});

it('remove pins the pushed state to what datastoreGet returned and stamps dropped_at; clearDropped resets it', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  const liveItem = {
    _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'p.jpg', removed: false, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-06-01T00:00:00.000Z',
    state: { timeOffset: 999, watched: 'no' }
  };
  const stateRow = () => db.prepare(
    `SELECT dropped_at FROM household_sync_state WHERE spoke='stremio' AND entity='watchlist' AND tmdb_id=278 AND media_type='movie'`
  ).get() as any;

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [liveItem] }), { status: 200 });
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  link([consumerId]);

  // -- pulse removes it because the title is on the server --
  await pollStremioSync(db);
  const removedChange = putBody.changes.find((c: any) => c._id === 'tt0111161');
  expect(removedChange.removed).toBe(true);
  expect(removedChange.state).toEqual(liveItem.state);
  expect(stateRow().dropped_at).not.toBeNull();

  // -- the title is present again in stremio (still tagged dropped by pulse) --
  putBody = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [{ ...liveItem, removed: false }] }), { status: 200 });
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  await pollStremioSync(db);
  expect(stateRow().dropped_at).toBeNull();
});

it('a declined request is not pushed to stremio', async () => {
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','declined',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  const calls: string[] = [];
  global.fetch = (vi.fn(async (url: any) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ result: [] }), { status: 200 });
  }) as any);
  link([consumerId]);
  await pollStremioSync(db);
  expect(calls.some((u) => u.endsWith('/datastorePut'))).toBe(false);
});

it('imports a title the viewer saved in stremio', async () => {
  seedMeta('tt0903747', 1396, 'series', 'Breaking Bad');

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0903747', name: 'Breaking Bad', type: 'series', poster: null,
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  const rows = listWatchlist(db, consumerId);
  expect(rows.map((r) => r.tmdbId)).toEqual([1396]);
  expect(rows[0].mediaType).toBe('tv');
  // A title the viewer saved in Stremio is NOT a notify subscription they asked pulse for. With
  // notify_on_available=1 the availability poller would fire a web push AND a Telegram DM AND
  // write a Jellyfin favourite for it — times the whole library, on the very first link.
  expect(rows[0].notifyOnAvailable).toBe(false);
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
  link([consumerId]);
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('propagates a hand-removal from stremio to the pulse watchlist', async () => {
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
        removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('does NOT delete the pulse row when pulse itself dropped the item', async () => {
  // onServer:false is deliberate: with onServer:true the reconciler's own onServer branch exits
  // before ever reaching the droppedAt===null guard, so the assertion below would hold even if
  // that guard were inverted. onServer:false is what actually drives the item into the
  // `s.removed` check and exercises "droppedAt !== null routes to push, not deleteItems".
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',278,'movie',?,?)`
  ).run(Date.now(), Date.now());

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
        removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
});

// --- fix round 1 (task 6) ---

it('CRITICAL: a failed datastorePut must not clear dropped_at, or the next cycle deletes the watchlist row', async () => {
  // Same setup as "does NOT delete..." above: onServer:false, dropped_at already set (pulse
  // dropped this earlier), Stremio still holds it tombstoned -> reconciler pushes it, it does
  // NOT delete it. The bug: the push loop used to clear dropped_at to NULL as soon as it decided
  // to push, before datastorePut ran. If datastorePut then fails, that clear is still committed
  // (better-sqlite3 autocommits per statement, no transaction wraps the loop). Next cycle reads
  // dropped_at=NULL and, since the item is STILL tombstoned in Stremio, the reconciler now
  // routes it to deleteItems -- and applyPull faithfully deletes the viewer's row over nothing
  // more than a transient network error.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  db.prepare(
    `INSERT INTO household_sync_state(spoke,entity,tmdb_id,media_type,synced_at,dropped_at)
     VALUES ('stremio','watchlist',278,'movie',?,?)`
  ).run(Date.now(), Date.now());

  const tombstoned = {
    _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
    removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
  };

  link([consumerId]);

  // -- cycle 1: datastoreGet returns the tombstone, datastorePut fails with a transient 5xx --
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [tombstoned] }), { status: 200 });
    }
    return new Response('nope', { status: 500 });
  }) as any);
  await pollStremioSync(db);

  // -- cycle 2: same tombstone (the failed put never changed Stremio's state), put succeeds now --
  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [tombstoned] }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  await pollStremioSync(db);

  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
});

it('one Cinemeta failure on an import does not block the other imports and deletes that cycle', async () => {
  // Without per-item isolation, applyPull's importItems loop throws on the FIRST bad id and
  // that exception propagates straight out of applyPull -- aborting not just the remaining
  // imports but the deleteItems loop that runs after it in the same function, every cycle,
  // indefinitely. This seeds one steady (untouched) item, one hand-removed item (must still be
  // deleted), one importable-but-poisoned id (Cinemeta 500s), and one importable-and-healthy id
  // (must still land) -- all in the same cycle.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId, tmdbId: 500, mediaType: 'movie', title: 'Removed By Hand', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  seedMeta('tt0500000', 500, 'movie', 'Removed By Hand');
  // tt0903747 IS cached (a healthy, already-known-to-Cinemeta import); tt9999999 is NOT cached,
  // so applyPull's resolveImdbMeta will hit fetchCinemetaMeta and get a 500 -- an id Cinemeta
  // chokes on, distinct from a clean 404 (unresolvable).
  seedMeta('tt0903747', 1396, 'series', 'Breaking Bad');

  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [
        { _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null, removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {} },
        { _id: 'tt0500000', name: 'Removed By Hand', type: 'movie', poster: null, removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {} },
        { _id: 'tt9999999', name: '?', type: 'movie', poster: null, removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {} },
        { _id: 'tt0903747', name: 'Breaking Bad', type: 'series', poster: null, removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {} }
      ] }), { status: 200 });
    }
    if (u.includes('cinemeta')) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  // tt9999999's poisoned import never lands; the steady item (278) is untouched, the
  // hand-removed item (500) is still deleted, and the healthy import (1396) still lands --
  // proof the exception from the bad id did not abort the rest of the cycle.
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId).sort((a, b) => a - b)).toEqual([278, 1396]);
  expect(readHousehold(db)!.lastSyncAt).not.toBeNull();
});

// --- final review fixes ---

it('CRITICAL: an import never resets an existing row\'s on_server (a Seerr blip must not re-notify)', async () => {
  // 278 is already on the server and the viewer was already told about it. Its imdb id is NOT
  // cached against a tmdb id and there is no Seerr connection, so `imdbForTmdb` returns null —
  // exactly what a transient Seerr error produces. The item therefore drops out of `knownImdb`,
  // Stremio's copy looks unknown, and the pull direction imports it. With addWatchlist's upsert
  // (`on_server=excluded.on_server`) that import silently reset on_server 1 -> 0, and the next
  // availability tick fired a second "Ready to watch" for a title the viewer already has.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: true });

  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: null,
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    if (u.includes('cinemeta')) {
      return new Response(JSON.stringify({
        meta: { imdb_id: 'tt0111161', id: 'tt0111161', moviedb_id: 278, name: 'Shawshank', poster: null, type: 'movie' }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  const rows = listWatchlist(db, consumerId);
  expect(rows.map((r) => r.tmdbId)).toEqual([278]);
  expect(rows[0].onServer).toBe(true);
});

it('imports at most MAX_IMPORTS_PER_CYCLE titles per cycle, the rest on the next', async () => {
  // A first link sees the viewer's ENTIRE library as import candidates. Unbounded, that is 30
  // sequential Cinemeta round-trips inside the poller's _running guard, starving every other
  // job behind it. Nothing is lost: the leftovers are still unknown next cycle.
  const library: any[] = [];
  for (let i = 0; i < 30; i++) {
    const imdb = `tt10000${String(i).padStart(2, '0')}`;
    seedMeta(imdb, 1000 + i, 'movie', `Title ${i}`);
    library.push({
      _id: imdb, name: `Title ${i}`, type: 'movie', poster: null,
      removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
    });
  }

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: library }), { status: 200 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).length).toBe(MAX_IMPORTS_PER_CYCLE);
  expect(MAX_IMPORTS_PER_CYCLE).toBe(25);

  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).length).toBe(30);
});

it('a request that flipped to available is removed from stremio instead of vanishing', async () => {
  // 'available' rows used to drop straight out of the push set, so the reconciler never saw them:
  // the title stayed in the Library forever AND — being absent from pulse's view — came back
  // through the pull as a "the viewer saved this" import, firing a second Ready-to-watch.
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','available',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'p.jpg',
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: { timeOffset: 12 }
      }] }), { status: 200 });
    }
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  const change = putBody.changes.find((c: any) => c._id === 'tt0111161');
  expect(change.removed).toBe(true);
  expect(change.state).toEqual({ timeOffset: 12 }); // progress preserved on the way out
  // and it is NOT laundered back in as a watchlist row with a fresh notify
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('a Cinemeta failure on one PUSHED title still pushes the others and runs the deletes', async () => {
  // Mirror image of the import-side isolation test. tmdb 999's imdb id comes from Seerr, so it
  // has no Cinemeta cache row and the push loop goes to the network for it; unguarded, that 5xx
  // escapes past datastorePut, the sync_state drain and applyPull — killing every other push and
  // every pending delete for this household, every cycle.
  addWatchlist(db, { consumerId, tmdbId: 999, mediaType: 'movie', title: 'Poisoned', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId, tmdbId: 500, mediaType: 'movie', title: 'Removed By Hand', onServer: false, notifyOnAvailable: true });
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  seedMeta('tt0500000', 500, 'movie', 'Removed By Hand');
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr.local', secret: 'sk', options: {} });

  let putBody: any = null;
  global.fetch = (vi.fn(async (url: any, init: any) => {
    const u = String(url);
    if (u.includes('seerr.local')) {
      return new Response(JSON.stringify({ externalIds: { imdbId: 'tt5555555' } }), { status: 200 });
    }
    if (u.includes('cinemeta')) return new Response('boom', { status: 500 });
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt0500000', name: 'Removed By Hand', type: 'movie', poster: null,
        removed: true, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    putBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  // both titles push -- the poisoned one simply ships without metadata (name falls back to the
  // pulse title), which buildLibraryItem already supports
  const ids = putBody.changes.map((c: any) => c._id).sort();
  expect(ids).toEqual(['tt0111161', 'tt5555555']);
  expect(putBody.changes.find((c: any) => c._id === 'tt5555555').name).toBe('Poisoned');
  // and the hand-removal delete still ran
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId).sort((a, b) => a - b)).toEqual([278, 999]);
});

it('a cycle that dropped an import leaves last_error set instead of reporting a clean sync', async () => {
  // recordHouseholdSuccess's blanket lastError=null made a cycle that silently dropped every
  // import indistinguishable from a clean one, in the DB and in GET /api/stremio.
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [{
        _id: 'tt9999999', name: '?', type: 'movie', poster: null,
        removed: false, temp: false, _ctime: 'x', _mtime: 'x', state: {}
      }] }), { status: 200 });
    }
    if (u.includes('cinemeta')) return new Response('boom', { status: 500 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  const h = readHousehold(db)!;
  expect(h.lastError).toBeTruthy();
  expect(h.lastError).toContain('could not be imported');
  // the credential itself worked, so the sync stamp still advances and nothing counts to MAX_FAILS
  expect(h.lastSyncAt).not.toBeNull();
  expect(getStremioConnection(db)!.enabled).toBe(true);
});

it('explains why nothing pushes when there is no Seerr connection to resolve imdb ids', async () => {
  // imdbForTmdb is the only forward tmdb -> imdb path and it returns null with no Seerr enabled,
  // so the reconciler skips every pulse-owned row: the push direction is a total no-op while the
  // pull keeps working and recordHouseholdSuccess reports a clean cycle forever.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: true });

  global.fetch = (vi.fn(async (url: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  link([consumerId]);
  await pollStremioSync(db);

  expect(readHousehold(db)!.lastError).toContain('Seerr');
});

it('buildLibraryItem keeps the item\'s own name and poster when reviving and Cinemeta says nothing', () => {
  const tombstoned = {
    _id: 'tt0111161', name: 'Shawshank', type: 'movie', poster: 'real.jpg', removed: true, temp: false,
    _ctime: '2020-01-01T00:00:00.000Z', _mtime: '2020-06-01T00:00:00.000Z',
    state: { timeOffset: 4200 }
  } as any;
  const item = buildLibraryItem(want, tombstoned, null);
  expect(item.name).toBe('Shawshank');
  expect(item.poster).toBe('real.jpg');
  expect(item.state).toEqual({ timeOffset: 4200 });
});

// --- fix round 2: duplicate consumer_requests rows for the same title ---
//
// consumer_requests has no unique constraint on (consumer_id, tmdb_id, media_type), and
// createRequest inserts unconditionally, so a viewer who re-requests a title they already have
// ends up with TWO rows for it: one 'available', one 'pending'. inFlightRequests used to hand
// both straight through, so loadPulseItems yielded two PulseItems with the same imdbId and
// contradictory onServer flags, sharing one sync_state row (markSynced keys on tmdb_id+media_type
// only). That made the Library oscillate forever: the 'pending' row pushes, the 'available' row
// removes the very next cycle, the removal tombstones the shared sync_state row, the 'pending'
// row sees it tombstoned-but-still-wanted and re-pushes -- repeat, hitting the real Stremio
// account every poll tick.

it('loadPulseItems collapses duplicate request rows for one title into a single not-yet-available item', async () => {
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','available',?)`
  ).run(consumerId, Date.now());
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','pending',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  const items = await loadPulseItems(db, [consumerId], null);
  const forTitle = items.filter((i) => i.tmdbId === 278 && i.mediaType === 'movie');
  // one row still pending -> the title as a whole is not-yet-available, no matter how many other
  // rows for it already say 'available'.
  expect(forTitle.length).toBe(1);
  expect(forTitle[0].onServer).toBe(false);
});

it('loadPulseItems treats a title as landed only when every request row for it is available', async () => {
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','available',?)`
  ).run(consumerId, Date.now());
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','available',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  const items = await loadPulseItems(db, [consumerId], null);
  const forTitle = items.filter((i) => i.tmdbId === 278 && i.mediaType === 'movie');
  expect(forTitle.length).toBe(1);
  expect(forTitle[0].onServer).toBe(true);
});

it('CRITICAL: duplicate request rows for the same title do not oscillate the Stremio Library', async () => {
  // The exact shape from the bug report: a viewer re-requests a title they already have, so
  // there is one 'available' row and one 'pending' row for it, and no watchlist row to dedupe
  // against. Two consecutive cycles: the first pushes it (nothing in Stremio yet); the second
  // must NOT touch the Library again just because a duplicate row disagrees with the one that
  // caused the push.
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','available',?)`
  ).run(consumerId, Date.now());
  db.prepare(
    `INSERT INTO consumer_requests(consumer_id,tmdb_id,media_type,title,status,created_at)
     VALUES (?,278,'movie','Shawshank','pending',?)`
  ).run(consumerId, Date.now());
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');

  link([consumerId]);

  // -- cycle 1: title absent from stremio -> pushed --
  let putCalls: any[] = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [] }), { status: 200 });
    putCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  await pollStremioSync(db);
  expect(putCalls.length).toBe(1);
  expect(putCalls[0].changes.map((c: any) => c._id)).toEqual(['tt0111161']);
  expect(putCalls[0].changes[0].removed).toBe(false);

  // -- cycle 2: what cycle 1 pushed is now what Stremio holds -- nothing changed on pulse's side --
  const pushedItem = putCalls[0].changes[0];
  putCalls = [];
  global.fetch = (vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith('/datastoreGet')) return new Response(JSON.stringify({ result: [pushedItem] }), { status: 200 });
    putCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);
  await pollStremioSync(db);

  // no datastorePut at all this cycle: the buggy version made one here (removed:true, driven by
  // the duplicate 'available' row), which is the write that hits the real account every 120s.
  expect(putCalls.length).toBe(0);
});

// --- household scope ---

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
  // A note, NOT a failure. "Nobody picked yet" is a local configuration state, not a dead
  // credential: counting it toward MAX_FAILS would disable the connection after ~10 minutes of
  // polling and force the admin to re-enter the password to fix something they never broke.
  expect(readHousehold(db)!.failCount).toBe(0);
  expect(getStremioConnection(db)!.enabled).toBe(true);
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
  queueRemoval(4242, 'movie'); // no imdb_meta_cache row at enqueue time -> imdb_id null
  // Cinemeta DOES know the id Stremio keys this title on; only the queue row missed the mapping.
  // So the title reaches the reconciler as an ordinary import candidate, and the removal — which
  // has no imdb id to be excluded by — has to be honoured at the import stage or not at all.
  seedMeta('tt4242', 4242, 'movie', 'Unresolvable');
  const { puts } = stubStremio([{ _id: 'tt4242', name: 'Unresolvable', type: 'movie', removed: false }]);
  await pollStremioSync(db);
  // Nothing pushable: with no imdb id on the queue row there is no document to tombstone. The
  // old assertion here (`changes.every(...)` over an empty array) was vacuously true under any
  // implementation, including one that re-imported the title.
  expect(puts).toHaveLength(0);
  // The removal must not be actively UNDONE either: unpushable is not the same as re-imported.
  expect(listWatchlist(db, consumerId)).toEqual([]);
  expect(listHouseholdRemovals(db)).toEqual([]);
});

it('CRITICAL: a queued removal with no imdb id is not re-imported into any participant', async () => {
  link([consumerId, otherId]);
  queueRemoval(4242, 'movie'); // imdb_id null: nothing had cached the mapping yet
  // Nothing is cached at all here, so applyPull resolves tt4242 over the network. That fetch is
  // the first moment the tmdb id the queue is keyed on exists in this cycle — and the only point
  // where the removal can be compared against the import, the reconciler's input being keyed on
  // imdb id. Without the suppression the title fans out to EVERY participant on the very cycle
  // its removal is settled, which is worse than merely failing to push it.
  global.fetch = (vi.fn(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/datastoreGet')) {
      return new Response(JSON.stringify({ result: [
        { _id: 'tt4242', name: 'Unresolvable', type: 'movie', removed: false }
      ] }), { status: 200 });
    }
    if (u.includes('cinemeta')) {
      return new Response(JSON.stringify({
        meta: { id: 'tt4242', imdb_id: 'tt4242', moviedb_id: 4242, name: 'Unresolvable', type: 'movie' }
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: {} }), { status: 200 });
  }) as any);

  await pollStremioSync(db);

  expect(listWatchlist(db, consumerId)).toEqual([]);
  expect(listWatchlist(db, otherId)).toEqual([]);
});

it('says out loud that an unresolvable removal could not be taken off the Library', async () => {
  // The only user-visible signal that a removal was queued and never reached Stremio. Without it
  // the cycle reports as clean and the title simply stays on the TV with no explanation.
  link([consumerId]);
  queueRemoval(4242, 'movie');
  stubStremio([]);
  await pollStremioSync(db);
  expect(readHousehold(db)!.lastError).toMatch(/1 removed title\(s\) could not be taken off the Stremio Library/);
});

it('a title re-saved on the TV (but not in pulse) is still tombstoned — the pulse actor wins the cycle', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId]);
  queueRemoval(278, 'movie');
  // _mtime AFTER the removal: the Library item genuinely changed later. Nobody re-added it in
  // pulse though, so the only recorded intent is the removal, and it wins this cycle.
  const { puts } = stubStremio([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false,
      _mtime: new Date(Date.now() + 60_000).toISOString() }
  ]);
  await pollStremioSync(db);
  expect(puts[0].changes[0].removed).toBe(true);
  expect(listWatchlist(db, consumerId)).toEqual([]);
});

it('CRITICAL: a title re-added before the poll is not tombstoned, and its row survives two cycles', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  queueRemoval(278, 'movie');
  // Somebody wants it again before the poll ran — the removal is stale.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });
  const { puts } = stubStremio([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }
  ]);

  await pollStremioSync(db);

  // Never two documents for one _id, and never a tombstone for a title pulse wants.
  const ids = (puts[0]?.changes ?? []).map((c: any) => c._id);
  expect(new Set(ids).size).toBe(ids.length);
  expect((puts[0]?.changes ?? []).some((c: any) => c._id === 'tt0111161' && c.removed === true)).toBe(false);
  // The stale queue row is settled rather than left to retry.
  expect(listHouseholdRemovals(db)).toEqual([]);
  // and the row is still there after a SECOND cycle — this is the half that catches the
  // deleteItems cascade, which only fires on the cycle after the tombstone lands.
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
});

it('CRITICAL: a landed tombstone never cascades into deleting a re-added title from every participant', async () => {
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  queueRemoval(278, 'movie');
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });

  // The live stub is load-bearing here: the deleteItems cascade only fires on the cycle AFTER
  // the tombstone is really in the Library, which a static fixture can never show.
  const { library } = stubStremioLive([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }
  ]);

  await pollStremioSync(db);
  await pollStremioSync(db);

  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
  expect(library.find((i) => i._id === 'tt0111161')!.removed).toBe(false);
});

it('CRITICAL: re-adding a removed title later revives it instead of being eaten', async () => {
  // The drain tombstones a title in Stremio exactly like `plan.remove` does, so it must stamp the
  // same household_sync_state provenance. Unstamped, the NEXT cycle reads its own tombstone as a
  // viewer deletion and fans a removeWatchlist out to every participant — so every re-add is
  // eaten one poll later, forever, and the title is unrecoverable from inside pulse.
  seedMeta('tt0111161', 278, 'movie', 'Shawshank');
  link([consumerId, otherId]);
  queueRemoval(278, 'movie');
  // Cycle 1: the removal is pushed and the queue clears.
  const live = stubStremioLive([
    { _id: 'tt0111161', name: 'Shawshank', type: 'movie', removed: false }
  ]);
  await pollStremioSync(db);
  expect(live.library[0].removed).toBe(true);

  // The viewer changes their mind days later.
  addWatchlist(db, { consumerId, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: false, notifyOnAvailable: false });

  // Cycle 2 must REVIVE it, not read the tombstone as a viewer deletion.
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
  // Cycle 3 proves it is stable, not merely deleted one cycle later.
  await pollStremioSync(db);
  expect(listWatchlist(db, consumerId).map((r) => r.tmdbId)).toEqual([278]);
});
