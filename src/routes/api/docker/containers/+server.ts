import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listContainers } from '$lib/server/docker';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return json(await listContainers());
};
