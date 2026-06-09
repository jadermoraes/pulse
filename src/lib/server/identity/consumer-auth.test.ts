import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { createRole } from './roles';
import { createConsumer, updateConsumer, setStatus } from './consumers';
import {
  loginConsumer, validateConsumerSession, destroyConsumerSession
} from './consumer-auth';

let db: DB; let roleId: number; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'JFKEY', options: {} });
  roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  updateConsumer(db, consumerId, { jellyfinUserId: 'jf-123' });
  setStatus(db, consumerId, 'active');
});
afterEach(() => vi.restoreAllMocks());

function mockJellyfinAuth(userId: string | null) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (userId == null) return new Response('no', { status: 401 });
    return new Response(JSON.stringify({ User: { Id: userId, Name: 'ana' } }), { status: 200 });
  }));
}

describe('consumer-auth', () => {
  it('logs in via Jellyfin AuthenticateByName, maps to consumer, issues a session', async () => {
    mockJellyfinAuth('jf-123');
    const sid = await loginConsumer(db, 'ana', 'pw');
    expect(typeof sid).toBe('string');
    const sess = validateConsumerSession(db, sid!)!;
    expect(sess.id).toBe(consumerId);
    expect(sess.roleId).toBe(roleId);
    expect(sess.displayName).toBe('Ana');
  });

  it('rejects when Jellyfin auth fails (bad password)', async () => {
    mockJellyfinAuth(null);
    await expect(loginConsumer(db, 'ana', 'bad')).rejects.toThrow();
  });

  it('rejects a Jellyfin user with no matching consumer', async () => {
    mockJellyfinAuth('jf-UNKNOWN');
    await expect(loginConsumer(db, 'ana', 'pw')).rejects.toThrow(/no pulse account|not found/i);
  });

  it('rejects a disabled consumer even with valid Jellyfin creds', async () => {
    setStatus(db, consumerId, 'disabled');
    mockJellyfinAuth('jf-123');
    await expect(loginConsumer(db, 'ana', 'pw')).rejects.toThrow(/disabled/i);
  });

  it('destroyConsumerSession invalidates the session', async () => {
    mockJellyfinAuth('jf-123');
    const sid = await loginConsumer(db, 'ana', 'pw');
    destroyConsumerSession(db, sid!);
    expect(validateConsumerSession(db, sid!)).toBeNull();
  });

  it('validate returns null for an expired session', async () => {
    mockJellyfinAuth('jf-123');
    const sid = await loginConsumer(db, 'ana', 'pw');
    db.prepare('update consumer_sessions set expires_at=? where id=?').run(Date.now() - 1, sid);
    expect(validateConsumerSession(db, sid!)).toBeNull();
  });
});
