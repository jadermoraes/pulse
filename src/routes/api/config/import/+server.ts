import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { parseAndValidate, applyConfig } from '$lib/server/config';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');

  let body: string;
  try {
    body = await request.text();
  } catch {
    throw error(400, 'Could not read request body');
  }

  if (!body.trim()) {
    throw error(400, 'Empty body');
  }

  const config = parseAndValidate(body);
  const result = applyConfig(getDb(), config);
  return json(result);
};
