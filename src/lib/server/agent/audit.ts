import type { DB } from '../db';
import { scrub } from './scrub';
import { registerPending } from './confirm';
import type { AgentContext, UndoToken } from './types';

export interface AuditRow {
  id: number; conversationId: number | null; ts: number; actor: number;
  tool: string; args: unknown; result: unknown; confirmed: boolean; undoToken: UndoToken | null;
}

export function recordAction(ctx: AgentContext, rec: {
  tool: string; args: Record<string, unknown>; result: unknown;
  confirmed: boolean; undoToken?: UndoToken | null;
}): number {
  const info = ctx.db.prepare(
    `insert into agent_actions(conversation_id,ts,actor,tool,args,result,confirmed,undo_token)
     values (?,?,?,?,?,?,?,?)`
  ).run(
    ctx.conversationId, Date.now(), ctx.user.id, rec.tool,
    JSON.stringify(scrub(rec.args)), JSON.stringify(scrub(rec.result)),
    rec.confirmed ? 1 : 0, rec.undoToken ? JSON.stringify(rec.undoToken) : null
  );
  return Number(info.lastInsertRowid);
}

export function listAudit(db: DB, opts: { limit?: number } = {}): AuditRow[] {
  const rows = db.prepare('select * from agent_actions order by id desc limit ?')
    .all(opts.limit ?? 50) as any[];
  return rows.map((r) => ({
    id: r.id, conversationId: r.conversation_id, ts: r.ts, actor: r.actor,
    tool: r.tool, args: JSON.parse(r.args), result: r.result ? JSON.parse(r.result) : null,
    confirmed: !!r.confirmed, undoToken: r.undo_token ? JSON.parse(r.undo_token) : null
  }));
}

/** Build a pending action from a recorded action's undo token (re-enters the confirm/audit path). */
export function undoToPending(ctx: AgentContext, auditId: number): string | null {
  const row = ctx.db.prepare('select undo_token from agent_actions where id=?').get(auditId) as
    { undo_token: string | null } | undefined;
  if (!row?.undo_token) return null;
  const token = JSON.parse(row.undo_token) as UndoToken;
  return registerPending({
    conversationId: ctx.conversationId, tool: token.tool, args: token.args,
    summary: `Undo: ${token.label}`
  });
}
