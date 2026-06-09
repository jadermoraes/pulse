import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getBotUsername } from '$lib/server/telegram/config';
import { listAdminChatIds } from '$lib/server/telegram/bindings';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  return json({ configured: !!getBotUsername(db), adminBound: listAdminChatIds(db).length > 0 });
};
