import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';
import { aggregateMostWatched } from '$lib/server/watch';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const connections = listConnections(getDb());
  const result = await aggregateMostWatched(connections);
  return json(result);
};
