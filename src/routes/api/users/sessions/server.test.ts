/**
 * Tests for GET /api/users/sessions and DELETE /api/users/sessions.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb, migrate, type DB } from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer, setStatus } from '$lib/server/identity/consumers';

let db: DB;

vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET, DELETE } from './+server';

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;

function insertSession(
  dbRef: DB,
  consumerId: number,
  opts: { createdAt?: number; ip?: string | null; userAgent?: string | null } = {}
): string {
  const id = randomBytes(24).toString('hex');
  const now = Date.now();
  dbRef.prepare(
    'insert into consumer_sessions (id, consumer_id, expires_at, created_at, ip, user_agent) values (?,?,?,?,?,?)'
  ).run(id, consumerId, now + SESSION_TTL, opts.createdAt ?? now, opts.ip ?? null, opts.userAgent ?? null);
  return id;
}

function callGet(consumerId: number | null, authenticated = true) {
  const qs = consumerId != null ? `?consumerId=${consumerId}` : '';
  const event = {
    url: new URL(`http://localhost/api/users/sessions${qs}`),
    locals: authenticated ? { user: { id: 1 } } : { user: null }
  };
  return GET(event as any);
}

function callDelete(body: unknown, authenticated = true) {
  const event = {
    request: new Request('http://localhost/api/users/sessions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    locals: authenticated ? { user: { id: 1 } } : { user: null }
  };
  return DELETE(event as any);
}

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
afterEach(() => vi.restoreAllMocks());

describe('GET /api/users/sessions', () => {
  it('returns sessions for a consumer', async () => {
    insertSession(db, consumerId, { ip: '10.0.0.1', userAgent: 'Mozilla/5.0 Chrome/120' });
    const res = await callGet(consumerId);
    const body = await res.json();
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].ip).toBe('10.0.0.1');
    expect(typeof body.sessions[0].device).toBe('string');
  });

  it('returns empty sessions for a consumer with no active sessions', async () => {
    const res = await callGet(consumerId);
    const body = await res.json();
    expect(body.sessions).toEqual([]);
  });

  it('returns 401 without admin auth', async () => {
    await expect(callGet(consumerId, false)).rejects.toMatchObject({ status: 401 });
  });

  it('returns 400 without consumerId', async () => {
    await expect(callGet(null)).rejects.toMatchObject({ status: 400 });
  });
});

describe('DELETE /api/users/sessions', () => {
  it('revokes a session by id', async () => {
    const sid = insertSession(db, consumerId);
    const res = await callDelete({ id: sid });
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Verify the session is gone from DB
    const row = db.prepare('select id from consumer_sessions where id=?').get(sid);
    expect(row).toBeUndefined();
  });

  it('returns 401 without admin auth', async () => {
    await expect(callDelete({ id: 'anything' }, false)).rejects.toMatchObject({ status: 401 });
  });

  it('returns 400 when id is missing', async () => {
    await expect(callDelete({})).rejects.toMatchObject({ status: 400 });
  });
});
