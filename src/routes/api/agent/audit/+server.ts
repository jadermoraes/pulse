import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listAudit } from '$lib/server/agent/audit';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const limit = Number(url.searchParams.get('limit')) || 50;
  return json({ actions: listAudit(getDb(), { limit }) });
};
