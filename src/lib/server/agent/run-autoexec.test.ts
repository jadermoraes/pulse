import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { registerIntegration } from '../integrations/registry';
import type { Integration } from '../integrations/types';
import { buildToolSpecs } from './tools';
import { executeWriteInline } from './run';
import { listAudit } from './audit';
import type { AgentContext } from './types';

const svc: Integration = {
  type: 'autosvc', label: 'Auto', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {},
  actions: { request: { id: 'request', label: 'R', kind: 'request',
    async run(_c, p) { return { ok: true, message: 'Requested', echoed: p }; } } }
};
registerIntegration(svc);

let db: DB; let ctx: AgentContext;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('insert into ai_conversations(id,created_at) values(1,?)').run(Date.now());
  createConnection(db, { type: 'autosvc', name: 'A', baseUrl: 'http://x', secret: 'KEY', options: {} });
  ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 };
});
afterEach(() => vi.restoreAllMocks());

describe('executeWriteInline', () => {
  it('runs the write, records a confirmed audit row, and appends a tool-result message', async () => {
    const specs = await buildToolSpecs(ctx);
    const runAction = specs.find((s) => s.name === 'runAction')!;
    const out: any = await executeWriteInline(ctx, runAction, 'runAction',
      { connectionId: 1, action: 'request', params: { mediaType: 'movie', tmdbId: 5 } });
    expect(out).toMatchObject({ ok: true });

    const audit = listAudit(db, { limit: 10 });
    expect(audit[0]).toMatchObject({ tool: 'runAction', confirmed: true });

    const msgs = db.prepare("select role from ai_messages where conversation_id=1").all() as any[];
    expect(msgs.some((m) => m.role === 'tool')).toBe(true);
  });
});
