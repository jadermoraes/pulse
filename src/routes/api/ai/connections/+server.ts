import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb, type DB } from '$lib/server/db';
import type { AiProvider } from '$lib/server/agent/provider';
import {
  createAiConnection, listAiConnections, getAiConnection,
  updateAiConnection, deleteAiConnection
} from '$lib/server/agent/ai-connections';
import { validateConnectionByModels } from '$lib/server/agent/ai-models';

const PROVIDERS: AiProvider[] = ['anthropic', 'openai', 'google', 'openai-compatible'];

/**
 * Validate a connection by confirming its key can LIST the provider's models
 * (no generation, no guessed model). Reachable /v1/models for keyless local
 * providers counts as valid. See validateConnectionByModels for the status mapping.
 */
async function validateConnection(db: DB, id: number): Promise<{ ok: boolean; error?: string }> {
  const conn = getAiConnection(db, id);
  if (!conn) return { ok: false, error: 'connection not found' };
  return validateConnectionByModels(conn);
}

// GET → list connections (no secrets).
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return json({ connections: listAiConnections(getDb()) });
};

// POST → create + (by default) validate with a ping. Body:
// { label, provider, baseUrl?, apiKey?, model?, validate? }. Returns { ok, id?, error? }.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { label?: string; provider?: AiProvider; baseUrl?: string; apiKey?: string; model?: string; validate?: boolean };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (!body.label) throw error(400, 'label required');
  if (!body.provider || !PROVIDERS.includes(body.provider)) throw error(400, 'provider required');

  const id = createAiConnection(db, {
    label: body.label, provider: body.provider, baseUrl: body.baseUrl ?? null, apiKey: body.apiKey ?? null
  });

  if (body.validate !== false) {
    const result = await validateConnection(db, id);
    if (!result.ok) {
      // Roll back the unverified connection so a bad key never lingers.
      deleteAiConnection(db, id);
      return json({ ok: false, error: result.error });
    }
  }
  return json({ ok: true, id });
};

// PUT → update an existing connection. Body: { id, label?, provider?, baseUrl?, apiKey?, model?, validate? }.
export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { id?: number; label?: string; provider?: AiProvider; baseUrl?: string | null; apiKey?: string; model?: string; validate?: boolean };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (body.id == null) throw error(400, 'id required');
  if (body.provider && !PROVIDERS.includes(body.provider)) throw error(400, 'invalid provider');
  if (!getAiConnection(db, body.id)) throw error(404, 'connection not found');

  updateAiConnection(db, body.id, {
    label: body.label, provider: body.provider, baseUrl: body.baseUrl, apiKey: body.apiKey
  });

  if (body.validate) {
    const result = await validateConnection(db, body.id);
    if (!result.ok) return json({ ok: false, error: result.error });
  }
  return json({ ok: true });
};

// DELETE → remove a connection. Body: { id }.
export const DELETE: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let body: { id?: number };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (body.id == null) throw error(400, 'id required');
  deleteAiConnection(db, body.id);
  return json({ ok: true });
};
