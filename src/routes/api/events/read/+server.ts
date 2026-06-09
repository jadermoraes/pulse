import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { markRead, markAllRead } from '$lib/server/agent/events';

// POST { ids: number[] } → mark those events read/dismissed.
// POST { all: true }     → mark ALL unread events read (bulk clear).
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: { ids?: number[]; all?: boolean };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (body.all) {
    markAllRead(getDb());
  } else {
    markRead(getDb(), (body.ids ?? []).map(Number).filter(Number.isFinite));
  }
  return json({ ok: true });
};
