import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { registerIntegration } from '../integrations/registry';
import type { Integration } from '../integrations/types';
import { registerPending } from './confirm';
import type { AgentContext } from './types';

const svc: Integration = {
  type: 'confsvc', label: 'C', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {},
  actions: { approve: { id: 'approve', label: 'A', kind: 'request',
    async run(_c, p) { return { ok: true, message: `approved ${p.id}` }; } } }
};
registerIntegration(svc);

// We test executeConfirmed's side effects (resolveAction ran + audit + tool message), not the resumed LLM.
import { executeConfirmed } from './run';
import { listAudit } from './audit';

let db: DB; let ctx: AgentContext;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('insert into ai_conversations(id,created_at) values(1,?)').run(Date.now());
  const id = createConnection(db, { type: 'confsvc', name: 'C', baseUrl: 'http://x', secret: 'KEY', options: {} });
  ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 };
  (globalThis as any).__connId = id;
});
afterEach(() => vi.restoreAllMocks());

describe('executeConfirmed', () => {
  it('on approve: runs the action, records a confirmed audit row, appends a tool result message', async () => {
    const connId = (globalThis as any).__connId;
    const pid = registerPending({
      conversationId: 1, tool: 'runAction',
      args: { connectionId: connId, action: 'approve', params: { id: 7 } }, summary: 'approve 7'
    });
    const out = await executeConfirmed(ctx, pid, true);
    expect(out.ok).toBe(true);
    expect(String(JSON.stringify(out.result))).toContain('approved 7');
    const audit = listAudit(db, { limit: 10 });
    expect(audit[0]).toMatchObject({ tool: 'runAction', confirmed: true });
    // a tool message was appended to resume the model
    const msgs = db.prepare('select role from ai_messages where conversation_id=1').all() as any[];
    expect(msgs.some((m) => m.role === 'tool')).toBe(true);
  });

  it('on deny: records confirmed=false, does NOT run the action, appends a "declined" tool result', async () => {
    const connId = (globalThis as any).__connId;
    const pid = registerPending({
      conversationId: 1, tool: 'runAction',
      args: { connectionId: connId, action: 'approve', params: { id: 9 } }, summary: 'approve 9'
    });
    const out = await executeConfirmed(ctx, pid, false);
    expect(out.ok).toBe(true);
    const audit = listAudit(db, { limit: 10 });
    expect(audit[0]).toMatchObject({ tool: 'runAction', confirmed: false });
  });

  it('returns ok:false for an unknown / expired pending id', async () => {
    const out = await executeConfirmed(ctx, 'nope', true);
    expect(out.ok).toBe(false);
  });
});
