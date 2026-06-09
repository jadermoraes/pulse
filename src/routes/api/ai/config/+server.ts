import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { generateText } from 'ai';
import { getDb } from '$lib/server/db';
import { loadAiRefs, saveAiRefs, modelFromConnection, type AiRefs } from '$lib/server/agent/provider';
import { getAiConnection, listAiConnections } from '$lib/server/agent/ai-connections';

// GET → current reference config + the (secret-free) list of connections.
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const refs = loadAiRefs(db);
  return json({
    adminConnectionId: refs.adminConnectionId,
    adminModel: refs.adminModel,
    adminTemperature: refs.adminTemperature,
    consumerConnectionId: refs.consumerConnectionId,
    consumerModel: refs.consumerModel,
    consumerTemperature: refs.consumerTemperature,
    connections: listAiConnections(db)
  });
};

// POST → save the references. Validates the referenced admin connection+model with a
// 1-token "ping" unless `validate:false`. Never returns a key.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: Partial<AiRefs> & { validate?: boolean };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }

  if (body.adminConnectionId == null) throw error(400, 'adminConnectionId required');
  if (!body.adminModel) throw error(400, 'adminModel required');

  const adminConn = getAiConnection(db, body.adminConnectionId);
  if (!adminConn) throw error(400, 'adminConnectionId not found');

  // Validate the admin ref with a 1-token ping unless explicitly skipped.
  if (body.validate !== false) {
    const model = modelFromConnection(adminConn, body.adminModel);
    if (!model) return json({ ok: false, error: 'Could not build model' });
    try {
      // 16 is OpenAI's documented minimum for max_output_tokens; works across providers.
      await generateText({ model, prompt: 'ping', maxOutputTokens: 16 });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message });
    }
  }

  // Validate the consumer connection exists when a consumer ref is supplied.
  if (body.consumerConnectionId != null && !getAiConnection(db, body.consumerConnectionId)) {
    throw error(400, 'consumerConnectionId not found');
  }

  const refs: AiRefs = {
    adminConnectionId: body.adminConnectionId,
    adminModel: body.adminModel,
    adminTemperature: body.adminTemperature,
    consumerConnectionId: body.consumerConnectionId ?? null,
    consumerModel: body.consumerModel ?? null,
    consumerTemperature: body.consumerTemperature
  };
  saveAiRefs(db, refs);
  return json({ ok: true });
};
