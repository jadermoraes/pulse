import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getPending } from '$lib/server/agent/confirm';
import { executeConfirmed, resumeAgentTurn } from '$lib/server/agent/run';
import { sseChannel } from '$lib/server/agent/channel';
import type { AgentContext } from '$lib/server/agent/types';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { pendingId?: string; approved?: boolean };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (!body.pendingId) throw error(400, 'pendingId required');

  const pending = getPending(body.pendingId);
  if (!pending) throw error(410, 'Pending action expired');
  const ctx: AgentContext = {
    db, user: locals.user, channel: 'web', conversationId: pending.conversationId
  };

  const encoder = new TextEncoder();
  const abort = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      const channel = sseChannel(controller, encoder);
      try {
        const outcome = await executeConfirmed(ctx, body.pendingId!, Boolean(body.approved));
        channel.send({ type: 'tool_result', tool: pending.tool, result: outcome.result });
        // Resume the model with the new tool result so it can summarize / continue.
        await resumeAgentTurn(ctx, channel, abort.signal);
      } catch (e) {
        channel.send({ type: 'error', message: (e as Error).message });
      } finally { try { controller.close(); } catch { /* already closed (client gone) */ } }
    },
    // Client disconnected: abort the resumed turn.
    cancel() { abort.abort(); }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' }
  });
};
