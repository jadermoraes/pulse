import { it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  saveCredential, getCredential, listEnabled, deleteCredential,
  recordSuccess, recordFailure, recordNote
} from './spoke-credentials';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  // Seed consumer_users for FK constraint (role_id=1 is the auto-created Admin role)
  db.prepare('INSERT INTO consumer_users(id, role_id, display_name, created_at) VALUES(?, ?, ?, ?)')
    .run(1, 1, 'Test Consumer 1', Date.now());
  db.prepare('INSERT INTO consumer_users(id, role_id, display_name, created_at) VALUES(?, ?, ?, ?)')
    .run(2, 1, 'Test Consumer 2', Date.now());
});

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

it('recordNote makes a message visible without counting it toward MAX_FAILS', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  for (let i = 0; i < 10; i++) recordNote(db, 1, 'trakt', 'Trakt watched HTTP 500');
  const cred = getCredential(db, 1, 'trakt');
  expect(cred?.enabled).toBe(true);
  expect(cred?.failCount).toBe(0);
  expect(cred?.lastError).toBe('Trakt watched HTTP 500');
});

it('recordNote leaves an already-counted fail_count alone', () => {
  saveCredential(db, { consumerId: 1, spoke: 'trakt', secret: 'a' });
  recordFailure(db, 1, 'trakt', 'unauthorized');
  recordNote(db, 1, 'trakt', 'transient');
  expect(getCredential(db, 1, 'trakt')?.failCount).toBe(1);
  expect(getCredential(db, 1, 'trakt')?.lastError).toBe('transient');
});
