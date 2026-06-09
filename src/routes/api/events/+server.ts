import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listEvents } from '$lib/server/agent/events';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Number(url.searchParams.get('limit')) || 50;
  const events = listEvents(getDb(), { unreadOnly, limit });
  const unreadCount = listEvents(getDb(), { unreadOnly: true, limit: 999 }).length;
  return json({ events, unreadCount });
};
