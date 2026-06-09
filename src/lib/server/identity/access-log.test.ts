import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { logAccess, listAccess, pruneAccess, describeDevice } from './access-log';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('logAccess / listAccess', () => {
  it('records and lists events newest-first', () => {
    logAccess(db, { consumerId: 1, type: 'login', ip: '10.0.0.1', userAgent: 'x', ts: 100 });
    logAccess(db, { consumerId: 1, type: 'request', detail: 'Dune', ts: 200 });
    const out = listAccess(db, {});
    expect(out.map((e) => e.type)).toEqual(['request', 'login']);
    expect(out[1].ip).toBe('10.0.0.1');
  });

  it('filters by consumerId and paginates with before-cursor', () => {
    for (let i = 1; i <= 5; i++) logAccess(db, { consumerId: 1, type: 'login', ts: i * 10 });
    logAccess(db, { consumerId: 2, type: 'login', ts: 999 });
    const firstPage = listAccess(db, { consumerId: 1, limit: 2 });
    expect(firstPage.map((e) => e.ts)).toEqual([50, 40]);
    const next = listAccess(db, { consumerId: 1, limit: 2, before: 40 });
    expect(next.map((e) => e.ts)).toEqual([30, 20]);
  });

  it('never throws on a bad insert (best-effort)', () => {
    expect(() => logAccess(db, { type: undefined as unknown as string })).not.toThrow();
  });
});

describe('pruneAccess', () => {
  it('drops rows older than the cutoff', () => {
    logAccess(db, { type: 'login', ts: 1 });
    logAccess(db, { type: 'login', ts: 1_000_000_000_000 });
    pruneAccess(db, 0, 500_000_000_000); // (db, _ignored, nowOverride) → cutoff = now - 90d
    expect(listAccess(db, {}).length).toBe(1);
  });
});

describe('describeDevice', () => {
  it('maps common UAs to friendly labels', () => {
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14)')).toBe('Android');
    expect(describeDevice('Mozilla/5.0 (Macintosh) Chrome/120')).toContain('Chrome');
    expect(describeDevice('')).toBe('');
  });
});
