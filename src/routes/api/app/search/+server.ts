import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { searchDiscover } from '$lib/server/consumer/discover';

export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  return json(await searchDiscover(getDb(), url.searchParams.get('q') ?? ''));
};
