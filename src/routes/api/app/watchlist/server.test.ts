/**
 * Route-level tests for the consumer watchlist API.
 *
 * Load-bearing properties: the endpoint is gated on the EXISTING `watchlist` capability (chat
 * already governs the same operations through it); `consumerId` never reaches the browser; and
 * removal is household-aware — a participant's removal clears every participant and queues one
 * Stremio tombstone, while a non-participant's removal is purely local and touches nobody else.
 * Hermetic in-memory DB.
 */
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

// The Jellyfin mirror is a network call, so it is stubbed rather than reached — but it must still
// be OBSERVED. Removing a title everywhere has to unfavourite it for every participant who had it
// on the server, or Jellyfin keeps a favourite for a title that is gone from every other surface.
const mirrorFavorite = vi.hoisted(() => vi.fn(async () => null));
vi.mock('$lib/server/consumer/jellyfin-favorite', () => ({ mirrorFavorite }));

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
  mirrorFavorite.mockClear();
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

it('rejects a DELETE from a viewer whose role lacks the watchlist capability', async () => {
  // DELETE is the destructive verb: a basic-role participant who slipped past the gate could wipe
  // the WHOLE household's list and queue a Stremio tombstone with a capability they do not hold.
  // The /api/app/* consumer guard in hooks.server.ts does not check capabilities, so this is the
  // only thing standing between them and that. Pin it harder than the read.
  const basic = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (3,'Basic','active',?)"
  ).run(Date.now()).lastInsertRowid);
  addWatchlist(db, { consumerId: basic, tmdbId: 278, mediaType: 'movie', title: 'S', onServer: false, notifyOnAvailable: false });
  const { DELETE } = await import('./+server');
  await expect((DELETE as any)({ locals: as(basic), request: del({ tmdbId: 278, mediaType: 'movie' }) }))
    .rejects.toMatchObject({ status: 403 });
  // and nothing was destroyed on the way to the rejection
  expect(listWatchlist(db, basic)).toHaveLength(1);
});

it('honours a per-consumer override that REVOKES the watchlist capability', async () => {
  // role 2 grants watchlist; the override takes it away. `allow_override` is a TEXT column holding
  // a JSON array, which `getConsumer` parses back into `allowOverride`.
  db.prepare('UPDATE consumer_users SET allow_override = ? WHERE id = ?')
    .run(JSON.stringify(['discover']), a);
  const { GET } = await import('./+server');
  await expect((GET as any)({ locals: as(a) })).rejects.toMatchObject({ status: 403 });
});

it('honours a per-consumer override that GRANTS the watchlist capability', async () => {
  // role 3 does not grant watchlist; the override does. Proves the override is genuinely consulted
  // rather than merely ANDed with the role's list.
  const basic = Number(db.prepare(
    "INSERT INTO consumer_users(role_id,display_name,status,created_at) VALUES (3,'Basic','active',?)"
  ).run(Date.now()).lastInsertRowid);
  db.prepare('UPDATE consumer_users SET allow_override = ? WHERE id = ?')
    .run(JSON.stringify(['discover', 'watchlist']), basic);
  const { GET } = await import('./+server');
  const res = await (GET as any)({ locals: as(basic) });
  expect(res.status).toBe(200);
});

it('returns the viewer own rows newest first, without leaking consumerId', async () => {
  addWatchlist(db, { consumerId: a, tmdbId: 1, mediaType: 'movie', title: 'Older', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: a, tmdbId: 3, mediaType: 'movie', title: 'Newer', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: b, tmdbId: 2, mediaType: 'movie', title: 'Theirs', onServer: false, notifyOnAvailable: true });
  // `addWatchlist` stamps Date.now(): two inserts inside one millisecond would tie and make the
  // ordering assertion vacuous, so force the timestamps apart.
  db.prepare('UPDATE consumer_watchlist SET added_at = ? WHERE consumer_id = ? AND tmdb_id = ?').run(1000, a, 1);
  db.prepare('UPDATE consumer_watchlist SET added_at = ? WHERE consumer_id = ? AND tmdb_id = ?').run(2000, a, 3);

  const { GET } = await import('./+server');
  const body = await (await (GET as any)({ locals: as(a) })).json();
  expect(body.map((r: any) => r.title)).toEqual(['Newer', 'Older']);  // newest first
  expect(body[0].consumerId).toBeUndefined();
  expect(body[0]).toMatchObject({ tmdbId: 3, mediaType: 'movie', onServer: false });
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

it('unfavourites in Jellyfin for every participant whose row carried an item id, and only those', async () => {
  // Inherited from the chat tool: a removal that skips this leaves a Jellyfin favourite set for a
  // title removed everywhere else. Replacing this loop body with `void 0` used to leave the whole
  // suite green.
  for (const id of [a, b, outsider]) {
    addWatchlist(db, { consumerId: id, tmdbId: 278, mediaType: 'movie', title: 'Shawshank', onServer: true, notifyOnAvailable: false });
  }
  // a is on the server (has a Jellyfin item id); b holds the same title with no item id resolved.
  db.prepare('UPDATE consumer_watchlist SET jellyfin_item_id = ? WHERE consumer_id = ? AND tmdb_id = 278').run('jf-a', a);
  db.prepare('UPDATE consumer_watchlist SET jellyfin_item_id = NULL WHERE consumer_id = ? AND tmdb_id = 278').run(b);
  db.prepare('UPDATE consumer_watchlist SET jellyfin_item_id = ? WHERE consumer_id = ? AND tmdb_id = 278').run('jf-out', outsider);
  saveStremioConnection(db, { email: 'tv@home.lan', authKey: 'ak' });
  setParticipants(db, [a, b]);

  const { DELETE } = await import('./+server');
  await (DELETE as any)({ locals: as(a), request: del({ tmdbId: 278, mediaType: 'movie' }) });

  // Exactly one call: the participant who had an item id. Not b (no item id to unfavourite), and
  // not the outsider, whose private row this removal never touched.
  expect(mirrorFavorite).toHaveBeenCalledTimes(1);
  expect(mirrorFavorite).toHaveBeenCalledWith(db, a, 278, 'movie', false);
});
