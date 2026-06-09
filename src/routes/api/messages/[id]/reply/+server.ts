import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getMessage, replyToMessage } from '$lib/server/consumer/messages';
import { notifyConsumer } from '$lib/server/notify';

export const POST: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const id = Number(params.id);
  let b: { body?: string };
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON');
  }
  const body = String(b.body ?? '').trim();
  if (!body) throw error(400, 'Empty reply');
  const db = getDb();
  const existing = getMessage(db, id);
  if (!existing) throw error(404, 'No such message');
  const row = replyToMessage(db, id, body);
  await notifyConsumer(db, existing.consumerId, {
    title: 'Reply from the admin',
    body,
    url: '/app/messages'
  }).catch(() => {
    /* best-effort */
  });
  return json({ message: row });
};
