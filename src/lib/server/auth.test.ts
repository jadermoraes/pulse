import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { isSetup, createAdmin, login, validateSession, hashPassword, verifyPassword } from './auth';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('auth', () => {
  it('hashes and verifies passwords', () => {
    const h = hashPassword('s3cret');
    expect(h).not.toContain('s3cret');
    expect(verifyPassword('s3cret', h)).toBe(true);
    expect(verifyPassword('wrong', h)).toBe(false);
  });

  it('reports setup state and creates the first admin', () => {
    expect(isSetup(db)).toBe(false);
    createAdmin(db, 'me@x.com', 'pw12345678');
    expect(isSetup(db)).toBe(true);
  });

  it('logs in and validates a session, rejects bad creds', () => {
    createAdmin(db, 'me@x.com', 'pw12345678');
    expect(login(db, 'me@x.com', 'nope')).toBeNull();
    const sid = login(db, 'me@x.com', 'pw12345678');
    expect(sid).toBeTypeOf('string');
    expect(validateSession(db, sid!)?.email).toBe('me@x.com');
    expect(validateSession(db, 'garbage')).toBeNull();
  });
});
