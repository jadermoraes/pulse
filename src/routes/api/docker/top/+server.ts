import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { topContainersByCpu } from '$lib/server/docker';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const limit = Number(url.searchParams.get('limit') ?? 5);
  return json(await topContainersByCpu(Number.isFinite(limit) ? limit : 5));
};
