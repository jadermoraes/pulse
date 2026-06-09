import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from './roles';
import { createConsumer } from './consumers';
import { mintInvite, getInvite, acceptInvite } from './invites';

let db: DB; let roleId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
});
afterEach(() => vi.useRealTimers());

describe('invites', () => {
  it('mints a high-entropy, role-bound, expiring token', () => {
    const inv = mintInvite(db, roleId, 1);
    expect(inv.token).toMatch(/^[0-9a-f]{48}$/);
    expect(inv.roleId).toBe(roleId);
    expect(inv.createdBy).toBe(1);
    expect(inv.expiresAt).toBeGreaterThan(Date.now());
    expect(inv.acceptedAt).toBeNull();
  });

  it('getInvite finds by token and returns null for unknown', () => {
    const inv = mintInvite(db, roleId, 1);
    expect(getInvite(db, inv.token)!.id).toBe(inv.id);
    expect(getInvite(db, 'nope')).toBeNull();
  });

  it('acceptInvite binds the consumer once and returns the role id', () => {
    const inv = mintInvite(db, roleId, 1);
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    const boundRole = acceptInvite(db, inv.token, cid);
    expect(boundRole).toBe(roleId);
    const after = getInvite(db, inv.token)!;
    expect(after.acceptedConsumerId).toBe(cid);
    expect(after.acceptedAt).not.toBeNull();
  });

  it('rejects reuse of an already-accepted invite', () => {
    const inv = mintInvite(db, roleId, 1);
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    acceptInvite(db, inv.token, cid);
    const cid2 = createConsumer(db, { roleId, displayName: 'B', language: 'en' });
    expect(() => acceptInvite(db, inv.token, cid2)).toThrow(/used|accepted/i);
  });

  it('rejects an expired invite', () => {
    vi.useFakeTimers();
    const inv = mintInvite(db, roleId, 1, 1000);
    vi.advanceTimersByTime(2000);
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    expect(() => acceptInvite(db, inv.token, cid)).toThrow(/expired/i);
  });

  it('rejects an unknown token', () => {
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    expect(() => acceptInvite(db, 'unknown', cid)).toThrow(/not found|invalid/i);
  });
});
