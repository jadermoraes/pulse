import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listMessages, markAdminRead, adminUnreadCount } from '$lib/server/consumer/messages';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const unreadOnly = url.searchParams.get('unreadOnly') === '1';
  const messages = listMessages(db, { unreadOnly });
  for (const m of messages) if (!m.readByAdmin) markAdminRead(db, m.id);
  return json({ messages, unread: adminUnreadCount(db) });
};
