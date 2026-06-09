import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { runAgentTurn } from '$lib/server/agent/run';
import { sseChannel } from '$lib/server/agent/channel';
import type { AgentContext } from '$lib/server/agent/types';

function ensureConversation(db: ReturnType<typeof getDb>, id?: number): number {
  if (id) {
    const row = db.prepare('select id from ai_conversations where id=?').get(id);
    if (row) return id;
  }
  const info = db.prepare('insert into ai_conversations(title,created_at) values(?,?)')
    .run(null, Date.now());
  return Number(info.lastInsertRowid);
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { message?: string; conversationId?: number };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const message = (body.message ?? '').trim();
  if (!message) throw error(400, 'message required');
  const conversationId = ensureConversation(db, body.conversationId);
  const ctx: AgentContext = { db, user: locals.user, channel: 'web', conversationId };

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      // First frame carries the conversationId so the client can persist it.
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'meta', conversationId })}\n\n`));
      const channel = sseChannel(controller, encoder);
      try { await runAgentTurn(ctx, channel, message, abort.signal); }
      catch (e) { channel.send({ type: 'error', message: (e as Error).message }); }
      finally { try { controller.close(); } catch { /* already closed (client gone) */ } }
    },
    // Client disconnected: abort the in-flight turn so the server stops working.
    cancel() { abort.abort(); }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
};
