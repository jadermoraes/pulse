import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { getSetting, setSetting } from './settings';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('settings', () => {
  it('returns null for an unknown key', () => {
    expect(getSetting(db, 'nope')).toBeNull();
  });

  it('inserts and reads back a value', () => {
    setSetting(db, 'dashboard_layout', '[]');
    expect(getSetting(db, 'dashboard_layout')).toBe('[]');
  });

  it('upserts (overwrites) an existing value', () => {
    setSetting(db, 'k', 'first');
    setSetting(db, 'k', 'second');
    expect(getSetting(db, 'k')).toBe('second');
  });
});
