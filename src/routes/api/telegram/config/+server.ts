import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { setBotToken, setBotUsername, getBotUsername } from '$lib/server/telegram/config';
import { tgGetMe } from '$lib/server/telegram/api';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const username = getBotUsername(db) || null;
  return json({ configured: !!username, botUsername: username });
};

export const PUT: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  let b: { token?: string };
  try { b = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const token = String(b.token ?? '').trim();
  if (!token) { setBotToken(db, ''); setBotUsername(db, ''); return json({ ok: true, configured: false }); }
  let me;
  try { me = await tgGetMe(token); } catch { throw error(400, 'Invalid bot token'); }
  setBotToken(db, token); setBotUsername(db, me.username);
  return json({ ok: true, configured: true, botUsername: me.username });
};
