import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConsumerRequests } from '$lib/server/consumer/requests';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  return json(await listConsumerRequests(getDb(), locals.consumer.id));
};
