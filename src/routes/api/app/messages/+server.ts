import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listMyMessages, markConsumerRead } from '$lib/server/consumer/messages';
import { submitConsumerMessage } from '$lib/server/consumer/submit-message';
import { getConsumer } from '$lib/server/identity/consumers';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const messages = listMyMessages(db, locals.consumer.id);
  markConsumerRead(db, locals.consumer.id);
  return json({ messages });
};

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  let b: { body?: string };
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const body = String(b.body ?? '').trim();
  if (!body) throw error(400, 'Empty message');
  const db = getDb();
  const who = getConsumer(db, locals.consumer.id)?.displayName ?? `consumer ${locals.consumer.id}`;
  const id = await submitConsumerMessage(db, locals.consumer.id, body, who);
  return json({ ok: id > 0 });
};
