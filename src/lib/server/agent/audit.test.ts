import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { recordAction, listAudit, undoToPending } from './audit';
import { getPending } from './confirm';
import type { AgentContext } from './types';

let db: DB; let ctx: AgentContext;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  db.prepare('insert into ai_conversations(id,created_at) values(1,?)').run(Date.now());
  ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 };
});

describe('audit', () => {
  it('records and lists confirmed + declined actions newest-first, scrubbed', () => {
    recordAction(ctx, { tool: 'runAction', args: { apiKey: 'SECRET', id: 1 }, result: { ok: true }, confirmed: true });
    recordAction(ctx, { tool: 'stopContainer', args: { id: 'c' }, result: { ok: false }, confirmed: false });
    const rows = listAudit(db, { limit: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0].tool).toBe('stopContainer');          // newest first
    expect(JSON.stringify(rows[1].args)).not.toContain('SECRET'); // scrubbed at rest
  });

  it('undoToPending creates a pending action from an undo token', () => {
    const auditId = recordAction(ctx, {
      tool: 'stopContainer', args: { id: 'c1' }, result: { ok: true }, confirmed: true,
      undoToken: { tool: 'restartContainer', args: { id: 'c1' }, label: 'Start container' }
    });
    const pid = undoToPending(ctx, auditId);
    expect(pid).toBeTruthy();
    const p = getPending(pid!)!;
    expect(p.tool).toBe('restartContainer');
    expect(p.args).toEqual({ id: 'c1' });
  });

  it('undoToPending returns null when the action has no undo token', () => {
    const auditId = recordAction(ctx, { tool: 'runAction', args: {}, result: {}, confirmed: true });
    expect(undoToPending(ctx, auditId)).toBeNull();
  });
});
