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
  // config.ts's import validator rejects an empty baseUrl, so an exported config would fail to
  // re-import. It must be a real absolute URL, not merely non-empty.
  expect(h.connection.baseUrl).toMatch(/^https?:\/\/[^\s]+$/);
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
  expect(participantIds(db, { ...conn, options: { participantIds: [a, 'x', 1.5, true, null, {}] } })).toEqual([a]);
});

it('setParticipants filters and dedupes on the way in', () => {
  saveStremioConnection(db, { email: 'fixture-account@example.invalid', authKey: 'ak' });
  setParticipants(db, [a, a, 'x' as any, 2.5 as any]);
  expect(participantIds(db, getStremioConnection(db)!)).toEqual([a]);
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
