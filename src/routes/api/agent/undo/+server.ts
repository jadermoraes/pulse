import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { undoToPending } from '$lib/server/agent/audit';
import type { AgentContext } from '$lib/server/agent/types';

// POST { auditId } → registers the inverse as a pending action and returns its id.
// The UI then POSTs /api/agent/confirm { pendingId, approved:true } to run it (same gate + audit).
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { auditId?: number };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (!body.auditId) throw error(400, 'auditId required');
  // The undo runs against the conversation the original action belonged to (or 0).
  const row = db.prepare('select conversation_id from agent_actions where id=?').get(body.auditId) as
    { conversation_id: number | null } | undefined;
  if (!row) throw error(404, 'Action not found');
  const ctx: AgentContext = {
    db, user: locals.user, channel: 'web', conversationId: row.conversation_id ?? 0
  };
  const pendingId = undoToPending(ctx, body.auditId);
  if (!pendingId) return json({ ok: false, error: 'This action cannot be undone' });
  return json({ ok: true, pendingId });
};
