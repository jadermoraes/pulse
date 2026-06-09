import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { resolveWidget } from '$lib/widgets';

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const id = Number(params.connectionId);
  if (!Number.isFinite(id)) throw error(400, 'Bad connection id');
  const result = await resolveWidget(getDb(), id, params.widget);
  return json(result);
};
