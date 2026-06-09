import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolveAction } from '$lib/server/actions';

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const id = Number(params.connectionId);
  if (!Number.isFinite(id)) throw error(400, 'Bad connection id');
  // Params come from the JSON body; tolerate an empty/absent body.
  let body: Record<string, unknown> = {};
  try {
    const text = await request.text();
    if (text) body = JSON.parse(text);
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const result = await resolveAction(getDb(), id, params.action, body);
  return json(result);
};
