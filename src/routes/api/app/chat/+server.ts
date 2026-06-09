import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { runConsumerTurn, consumerCapGate } from '$lib/server/consumer/consumer-turn';
import { sseChannel } from '$lib/server/agent/channel';
import type { AgentContext } from '$lib/server/agent/types';

/**
 * Resolve the conversation to use for this consumer turn, enforcing ownership.
 * - A supplied id is reused ONLY when it belongs to this consumer (consumer_id match).
 *   A foreign / admin (NULL) / missing id silently yields a fresh conversation owned by
 *   the caller — no 403, to avoid leaking whether an id exists (existence oracle).
 */
function ensureConversation(db: ReturnType<typeof getDb>, consumerId: number, id?: number): number {
  if (id) {
    const row = db.prepare('select consumer_id from ai_conversations where id=?').get(id) as
      | { consumer_id: number | null }
      | undefined;
    if (row && row.consumer_id === consumerId) return id;
  }
  const info = db
    .prepare('insert into ai_conversations(title,created_at,consumer_id) values(?,?,?)')
    .run(null, Date.now(), consumerId);
  return Number(info.lastInsertRowid);
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { message?: string; conversationId?: number };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const message = (body.message ?? '').trim();
  if (!message) throw error(400, 'message required');

  const consumer = locals.consumer;

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const channel = sseChannel(controller, encoder);
      try {
        // Cap-gate BEFORE materialising a conversation row so an over-cap request
        // never leaves an orphan empty conversation behind.
        if (consumerCapGate(db, consumer.id, consumer.roleId).blocked) {
          channel.send({ type: 'blocked', reason: 'cap' });
          return;
        }
        // Ownership-scoped resolution: a foreign/admin/missing id yields a fresh owned thread.
        const conversationId = ensureConversation(db, consumer.id, body.conversationId);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'meta', conversationId })}\n\n`));
        const ctx: AgentContext = {
          db, user: { id: 0, email: 'consumer' }, channel: 'web', conversationId,
          consumer: { id: consumer.id, roleId: consumer.roleId }
        };
        await runConsumerTurn(ctx, channel, message, abort.signal);
      } catch (e) {
        channel.send({ type: 'error', message: (e as Error).message });
      } finally {
        try { controller.close(); } catch { /* client gone */ }
      }
    },
    cancel() { abort.abort(); }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' }
  });
};
