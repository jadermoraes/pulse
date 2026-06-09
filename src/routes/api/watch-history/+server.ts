import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';
import { aggregateWatchHistory } from '$lib/server/watch';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const connections = listConnections(getDb());
  const result = await aggregateWatchHistory(connections);
  return json(result);
};
