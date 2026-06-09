import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { subscribe } from '$lib/server/consumer/push';

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const sub = await request.json();
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw error(400, 'Invalid subscription');
  subscribe(getDb(), locals.consumer.id, sub);
  return json({ ok: true });
};
