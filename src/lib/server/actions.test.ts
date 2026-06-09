import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { createConnection } from './connections';
import { registerIntegration } from './integrations/registry';
import type { Integration } from './integrations/types';
import { resolveAction, resolveDetail } from './actions';

const probe: Integration = {
  type: 'probe', label: 'Probe', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {},
  actions: {
    echo: { id: 'echo', label: 'Echo', kind: 'thing',
      async run(conn, params) { return { ok: true, message: `${conn.name}:${params.v}` }; } },
    boom: { id: 'boom', label: 'Boom', kind: 'thing',
      async run() { throw new Error('upstream 500'); } }
  },
  async detail(conn, params) {
    if (params.bad) throw new Error('detail upstream 500');
    return {
      title: `${conn.name}:${params.id}`,
      status: { label: 'Available', state: 'ok' },
      actions: []
    };
  }
};
registerIntegration(probe);

const plain: Integration = {
  type: 'plain', label: 'Plain', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {}
};
registerIntegration(plain);

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

describe('resolveAction', () => {
  it('errors for unknown connection', async () => {
    const r = await resolveAction(db, 999, 'echo', {});
    expect(r.ok).toBe(false);
  });
  it('errors for an action not in the allowlist', async () => {
    const id = createConnection(db, { type: 'probe', name: 'P', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveAction(db, id, 'not-a-real-action', {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Unknown action');
  });
  it('runs the action and passes params + connection', async () => {
    const id = createConnection(db, { type: 'probe', name: 'P', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveAction(db, id, 'echo', { v: 42 });
    expect(r).toMatchObject({ ok: true, message: 'P:42' });
  });
  it('isolates upstream errors into ok:false', async () => {
    const id = createConnection(db, { type: 'probe', name: 'P', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveAction(db, id, 'boom', {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('upstream 500');
  });
});

describe('resolveDetail', () => {
  it('404s for unknown connection', async () => {
    const r = await resolveDetail(db, 999, {});
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
  it('404s when the integration has no detail()', async () => {
    const id = createConnection(db, { type: 'plain', name: 'Q', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveDetail(db, id, {});
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
  it('returns the detail on success', async () => {
    const id = createConnection(db, { type: 'probe', name: 'P', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveDetail(db, id, { id: 7 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.detail.title).toBe('P:7');
  });
  it('isolates upstream errors into status 502', async () => {
    const id = createConnection(db, { type: 'probe', name: 'P', baseUrl: 'http://x', secret: null, options: {} });
    const r = await resolveDetail(db, id, { bad: true });
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
});
