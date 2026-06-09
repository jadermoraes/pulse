import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { scrub } from '$lib/server/agent/scrub';

// GET ?id=<n> → the messages for a conversation (most-recent conversation if no id).
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let convId = Number(url.searchParams.get('id'));
  if (!Number.isFinite(convId) || convId <= 0) {
    const last = db.prepare('select id from ai_conversations order by id desc limit 1').get() as any;
    convId = last?.id ?? 0;
  }
  if (!convId) return json({ conversationId: null, messages: [] });
  const rows = db.prepare(
    'select role, content, ts from ai_messages where conversation_id=? order by id'
  ).all(convId) as any[];
  // Only surface user + assistant text to the panel (tool plumbing stays internal), scrubbed.
  const messages = rows
    .map((r) => ({ role: r.role, content: JSON.parse(r.content), ts: r.ts }))
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => scrub(m));
  return json({ conversationId: convId, messages });
};

// DELETE ?id=<n> → clear a conversation (start fresh).
export const DELETE: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const id = Number(url.searchParams.get('id'));
  if (Number.isFinite(id) && id > 0) {
    db.prepare('delete from ai_messages where conversation_id=?').run(id);
    db.prepare('delete from ai_conversations where id=?').run(id);
  }
  return json({ ok: true });
};
