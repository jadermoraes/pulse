import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from './roles';
import { createConsumer, getConsumer } from './consumers';
import { getRole } from './roles';
import { currentPeriod, addUsage, monthToDate, isOverCap } from './usage';

let db: DB; let roleId: number; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  roleId = createRole(db, { name: 'M', allowList: [], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
});

describe('usage', () => {
  it('derives YYYY-MM from a timestamp arg', () => {
    expect(currentPeriod(Date.UTC(2026, 5, 5))).toBe('2026-06');
    expect(currentPeriod(Date.UTC(2026, 11, 31))).toBe('2026-12');
  });

  it('addUsage upserts atomically and accumulates within a period', () => {
    const at = Date.UTC(2026, 5, 10);
    addUsage(db, consumerId, 300, at);
    addUsage(db, consumerId, 250, at);
    expect(monthToDate(db, consumerId, at)).toBe(550);
  });

  it('resets at the month boundary (separate period rows)', () => {
    addUsage(db, consumerId, 900, Date.UTC(2026, 5, 28));
    addUsage(db, consumerId, 100, Date.UTC(2026, 6, 1));
    expect(monthToDate(db, consumerId, Date.UTC(2026, 5, 28))).toBe(900);
    expect(monthToDate(db, consumerId, Date.UTC(2026, 6, 2))).toBe(100);
  });

  it('isOverCap: true only at/above the effective cap; cheap reads (no usage) stay under', () => {
    const role = getRole(db, roleId)!;
    let c = getConsumer(db, consumerId)!;
    expect(isOverCap(db, c, role, Date.UTC(2026, 5, 5))).toBe(false);
    addUsage(db, consumerId, 1000, Date.UTC(2026, 5, 5));
    c = getConsumer(db, consumerId)!;
    expect(isOverCap(db, c, role, Date.UTC(2026, 5, 5))).toBe(true);
  });

  it('null cap (unlimited) is never over', () => {
    const unlimited = createRole(db, { name: 'U', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(db, { roleId: unlimited, displayName: 'B', language: 'en' });
    addUsage(db, cid, 9_999_999, Date.UTC(2026, 5, 5));
    const c = getConsumer(db, cid)!; const role = getRole(db, unlimited)!;
    expect(isOverCap(db, c, role, Date.UTC(2026, 5, 5))).toBe(false);
  });

  it('per-user cap override is honored by isOverCap', () => {
    const role = getRole(db, roleId)!;
    db.prepare('update consumer_users set cap_override=? where id=?').run(100, consumerId);
    addUsage(db, consumerId, 150, Date.UTC(2026, 5, 5));
    const c = getConsumer(db, consumerId)!;
    expect(isOverCap(db, c, role, Date.UTC(2026, 5, 5))).toBe(true);
  });
});
