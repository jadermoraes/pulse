import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { addWatchlist, listWatchlist, removeWatchlist, markOnServer, listPendingNotify } from './watchlist';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('add is idempotent (upsert) and list returns the consumer rows', () => {
  addWatchlist(db, { consumerId: 1, tmdbId: 100, mediaType: 'tv', title: 'Spider-Noir', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: 1, tmdbId: 100, mediaType: 'tv', title: 'Spider-Noir', onServer: false, notifyOnAvailable: true });
  const rows = listWatchlist(db, 1);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ tmdbId: 100, mediaType: 'tv', title: 'Spider-Noir', onServer: false, notifyOnAvailable: true });
});

it('list is scoped per consumer', () => {
  addWatchlist(db, { consumerId: 1, tmdbId: 1, mediaType: 'movie', title: 'A', onServer: true, notifyOnAvailable: false });
  addWatchlist(db, { consumerId: 2, tmdbId: 2, mediaType: 'movie', title: 'B', onServer: true, notifyOnAvailable: false });
  expect(listWatchlist(db, 1)).toHaveLength(1);
  expect(listWatchlist(db, 1)[0].tmdbId).toBe(1);
});

it('remove deletes only the matching row and returns the removed row', () => {
  addWatchlist(db, { consumerId: 1, tmdbId: 100, mediaType: 'tv', title: 'X', onServer: false, notifyOnAvailable: true });
  const removed = removeWatchlist(db, 1, 100, 'tv');
  expect(removed?.tmdbId).toBe(100);
  expect(listWatchlist(db, 1)).toHaveLength(0);
  expect(removeWatchlist(db, 1, 999, 'tv')).toBeNull();
});

it('markOnServer flips on_server and stores the jellyfin item id', () => {
  addWatchlist(db, { consumerId: 1, tmdbId: 100, mediaType: 'tv', title: 'X', onServer: false, notifyOnAvailable: true });
  markOnServer(db, 1, 100, 'tv', 'jf-42');
  const r = listWatchlist(db, 1)[0];
  expect(r.onServer).toBe(true);
  expect(r.jellyfinItemId).toBe('jf-42');
});

it('listPendingNotify returns distinct not-on-server flagged rows across consumers', () => {
  addWatchlist(db, { consumerId: 1, tmdbId: 100, mediaType: 'tv', title: 'X', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: 2, tmdbId: 100, mediaType: 'tv', title: 'X', onServer: false, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: 1, tmdbId: 7, mediaType: 'movie', title: 'Y', onServer: true, notifyOnAvailable: true });
  addWatchlist(db, { consumerId: 1, tmdbId: 8, mediaType: 'movie', title: 'Z', onServer: false, notifyOnAvailable: false });
  const pending = listPendingNotify(db);
  expect(pending).toEqual([{ tmdbId: 100, mediaType: 'tv' }]);
});
