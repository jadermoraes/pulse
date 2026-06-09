import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole, getAdminRole } from './roles';
import {
  createConsumer, getConsumer, listConsumers, updateConsumer, deleteConsumer,
  setStatus, markActive, getConsumerByJellyfinId,
  effectiveAllowList, effectiveCap
} from './consumers';

let db: DB; let roleId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  roleId = createRole(db, {
    name: 'Member', allowList: ['discover', 'request', 'status'],
    monthlyTokenCap: 50000, autoApprove: false, seerrQuota: { movie: 5 }
  });
});

describe('consumers', () => {
  it('creates a pending consumer and round-trips it', () => {
    const id = createConsumer(db, { roleId, displayName: 'Ana', language: 'pt-BR' });
    const c = getConsumer(db, id)!;
    expect(c.displayName).toBe('Ana');
    expect(c.language).toBe('pt-BR');
    expect(c.status).toBe('pending');
    expect(c.roleId).toBe(roleId);
    expect(c.capOverride).toBeNull();
    expect(c.allowOverride).toBeNull();
  });

  it('marks active + stores provisioned ids', () => {
    const id = createConsumer(db, { roleId, displayName: 'Bo', language: 'en' });
    updateConsumer(db, id, { jellyfinUserId: 'jf-1', seerrUserId: 42 });
    markActive(db, id);
    const c = getConsumer(db, id)!;
    expect(c.status).toBe('active');
    expect(c.jellyfinUserId).toBe('jf-1');
    expect(c.seerrUserId).toBe(42);
  });

  it('finds a consumer by jellyfin user id', () => {
    const id = createConsumer(db, { roleId, displayName: 'Cy', language: 'en' });
    updateConsumer(db, id, { jellyfinUserId: 'jf-x' });
    expect(getConsumerByJellyfinId(db, 'jf-x')!.id).toBe(id);
    expect(getConsumerByJellyfinId(db, 'nope')).toBeNull();
  });

  it('setStatus disables and lists consumers', () => {
    const id = createConsumer(db, { roleId, displayName: 'Di', language: 'en' });
    setStatus(db, id, 'disabled');
    expect(getConsumer(db, id)!.status).toBe('disabled');
    expect(listConsumers(db).length).toBe(1);
  });

  it('effectiveAllowList: role default unless per-user override', () => {
    const id = createConsumer(db, { roleId, displayName: 'Ev', language: 'en' });
    const role = { id: roleId, allowList: ['discover', 'request', 'status'] } as any;
    let c = getConsumer(db, id)!;
    expect(effectiveAllowList(c, role)).toEqual(['discover', 'request', 'status']);
    updateConsumer(db, id, { allowOverride: ['discover'] });
    c = getConsumer(db, id)!;
    expect(effectiveAllowList(c, role)).toEqual(['discover']);
    // an empty override means "nothing" (least privilege), not "fall back to role"
    updateConsumer(db, id, { allowOverride: [] });
    c = getConsumer(db, id)!;
    expect(effectiveAllowList(c, role)).toEqual([]);
  });

  it('effectiveCap: role cap unless per-user override (override 0 honored)', () => {
    const id = createConsumer(db, { roleId, displayName: 'Fi', language: 'en' });
    const role = { monthlyTokenCap: 50000 } as any;
    let c = getConsumer(db, id)!;
    expect(effectiveCap(c, role)).toBe(50000);
    updateConsumer(db, id, { capOverride: 1000 });
    c = getConsumer(db, id)!;
    expect(effectiveCap(c, role)).toBe(1000);
    updateConsumer(db, id, { capOverride: 0 });
    c = getConsumer(db, id)!;
    expect(effectiveCap(c, role)).toBe(0);
  });

  it('deletes a consumer', () => {
    const id = createConsumer(db, { roleId, displayName: 'Gu', language: 'en' });
    deleteConsumer(db, id);
    expect(getConsumer(db, id)).toBeNull();
  });

  it('jellyfinUsername round-trips: null by default, then persists via updateConsumer', () => {
    const id = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
    // New consumers start with null.
    expect(getConsumer(db, id)!.jellyfinUsername).toBeNull();
    // Persisting it via updateConsumer stores the value.
    updateConsumer(db, id, { jellyfinUsername: 'ana' });
    expect(getConsumer(db, id)!.jellyfinUsername).toBe('ana');
    // Other fields are unaffected by a jellyfinUsername-only patch.
    const c = getConsumer(db, id)!;
    expect(c.displayName).toBe('Ana');
    expect(c.status).toBe('pending');
    // Explicitly nulling it out works too.
    updateConsumer(db, id, { jellyfinUsername: null });
    expect(getConsumer(db, id)!.jellyfinUsername).toBeNull();
  });
});
