/**
 * Tests for listConsumerSessions / revokeConsumerSession.
 * Inserts sessions directly into the DB (no Jellyfin mock needed) to keep tests hermetic.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb, migrate, type DB } from '../db';
import { createRole } from './roles';
import { createConsumer, setStatus } from './consumers';
import { listConsumerSessions, revokeConsumerSession } from './consumer-auth';

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

function insertSession(
  db: DB,
  consumerId: number,
  opts: { createdAt?: number | null; ip?: string | null; userAgent?: string | null; expiresAt?: number } = {}
): string {
  const id = randomBytes(24).toString('hex');
  const now = Date.now();
  const expiresAt = opts.expiresAt ?? now + SESSION_TTL;
  const createdAt = opts.createdAt === undefined ? now : opts.createdAt;
  db.prepare(
    'insert into consumer_sessions (id, consumer_id, expires_at, created_at, ip, user_agent) values (?,?,?,?,?,?)'
  ).run(id, consumerId, expiresAt, createdAt, opts.ip ?? null, opts.userAgent ?? null);
  return id;
}

let db: DB;
let consumerId: number;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  const roleId = createRole(db, {
    name: 'Member', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {}
  });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  setStatus(db, consumerId, 'active');
});

describe('listConsumerSessions', () => {
  it('returns non-expired sessions with ip and userAgent', () => {
    insertSession(db, consumerId, { ip: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome/120' });
    const sessions = listConsumerSessions(db, consumerId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ip).toBe('1.2.3.4');
    expect(sessions[0].userAgent).toMatch(/Chrome/);
  });

  it('excludes expired sessions', () => {
    insertSession(db, consumerId, { expiresAt: Date.now() - 1 });
    const sessions = listConsumerSessions(db, consumerId);
    expect(sessions).toHaveLength(0);
  });

  it('returns sessions newest-first by created_at', () => {
    const now = Date.now();
    const sid1 = insertSession(db, consumerId, { createdAt: now - 2000, ip: 'first' });
    const sid2 = insertSession(db, consumerId, { createdAt: now - 1000, ip: 'second' });
    const sid3 = insertSession(db, consumerId, { createdAt: now, ip: 'third' });
    const sessions = listConsumerSessions(db, consumerId);
    expect(sessions.map((s) => s.id)).toEqual([sid3, sid2, sid1]);
  });

  it('sorts null created_at sessions last', () => {
    const now = Date.now();
    const sidNull = insertSession(db, consumerId, { createdAt: null, ip: 'null-ts' });
    const sidNew = insertSession(db, consumerId, { createdAt: now, ip: 'has-ts' });
    const sessions = listConsumerSessions(db, consumerId);
    // session with a timestamp should come before the one with null
    expect(sessions[0].id).toBe(sidNew);
    expect(sessions[sessions.length - 1].id).toBe(sidNull);
  });

  it('returns empty list when consumer has no sessions', () => {
    expect(listConsumerSessions(db, consumerId)).toEqual([]);
  });

  it('does not return sessions belonging to another consumer', () => {
    const roleId = createRole(db, {
      name: 'Other', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {}
    });
    const otherId = createConsumer(db, { roleId, displayName: 'Bob', language: 'en' });
    setStatus(db, otherId, 'active');
    insertSession(db, otherId, { ip: 'other' });
    expect(listConsumerSessions(db, consumerId)).toHaveLength(0);
  });
});

describe('revokeConsumerSession', () => {
  it('removes the session by id', () => {
    const sid = insertSession(db, consumerId);
    expect(listConsumerSessions(db, consumerId)).toHaveLength(1);
    revokeConsumerSession(db, sid);
    expect(listConsumerSessions(db, consumerId)).toHaveLength(0);
  });

  it('is a no-op for a non-existent id', () => {
    // Should not throw
    expect(() => revokeConsumerSession(db, 'does-not-exist')).not.toThrow();
  });

  it('only removes the targeted session, leaving others intact', () => {
    const sid1 = insertSession(db, consumerId, { ip: 'keep' });
    const sid2 = insertSession(db, consumerId, { ip: 'revoke' });
    revokeConsumerSession(db, sid2);
    const remaining = listConsumerSessions(db, consumerId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(sid1);
  });
});
