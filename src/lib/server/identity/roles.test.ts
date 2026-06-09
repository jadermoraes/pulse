import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { CAPABILITIES } from './types';
import { createRole, listRoles, getRole, updateRole, deleteRole, getAdminRole } from './roles';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('roles', () => {
  it('seeded admin role is present, immutable, and found by getAdminRole', () => {
    const admin = getAdminRole(db)!;
    expect(admin.isAdmin).toBe(true);
    expect(admin.editable).toBe(false);
    expect(listRoles(db).some((r) => r.isAdmin)).toBe(true);
  });

  it('creates a role with allow-list, cap, auto-approve and seerr quota and round-trips it', () => {
    const id = createRole(db, {
      name: 'Member', allowList: ['discover', 'request', 'status'],
      monthlyTokenCap: 50000, autoApprove: false, seerrQuota: { movie: 5, tv: 2 }
    });
    const r = getRole(db, id)!;
    expect(r.name).toBe('Member');
    expect(r.allowList).toEqual(['discover', 'request', 'status']);
    expect(r.monthlyTokenCap).toBe(50000);
    expect(r.autoApprove).toBe(false);
    expect(r.seerrQuota).toEqual({ movie: 5, tv: 2 });
    expect(r.isAdmin).toBe(false);
    expect(r.editable).toBe(true);
  });

  it('rejects capability keys outside CAPABILITIES', () => {
    expect(() => createRole(db, {
      name: 'Bad', allowList: ['discover', 'hack' as any], monthlyTokenCap: null,
      autoApprove: false, seerrQuota: {}
    })).toThrow(/capability/i);
  });

  it('rejects a duplicate role name', () => {
    createRole(db, { name: 'Dup', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    expect(() => createRole(db, { name: 'Dup', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} }))
      .toThrow();
  });

  it('updateRole edits a normal role', () => {
    const id = createRole(db, { name: 'M', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    updateRole(db, id, { name: 'M2', allowList: ['watchlist'], monthlyTokenCap: 100, autoApprove: true });
    const r = getRole(db, id)!;
    expect(r.name).toBe('M2');
    expect(r.allowList).toEqual(['watchlist']);
    expect(r.autoApprove).toBe(true);
  });

  it('refuses to edit or delete the immutable admin role', () => {
    const admin = getAdminRole(db)!;
    expect(() => updateRole(db, admin.id, { name: 'Hacked' })).toThrow(/immutable|admin/i);
    expect(() => deleteRole(db, admin.id)).toThrow(/immutable|admin/i);
  });

  it('deletes a normal role', () => {
    const id = createRole(db, { name: 'Temp', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    deleteRole(db, id);
    expect(getRole(db, id)).toBeNull();
  });

  it('exports the five capability keys', () => {
    expect(CAPABILITIES).toEqual(['discover', 'request', 'status', 'watchlist', 'message_admin']);
  });
});
