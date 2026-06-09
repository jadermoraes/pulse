import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { unsubscribe } from '$lib/server/consumer/push';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const { endpoint } = await request.json();
  if (!endpoint) throw error(400, 'endpoint required');
  unsubscribe(getDb(), locals.consumer.id, endpoint);
  return json({ ok: true });
};
