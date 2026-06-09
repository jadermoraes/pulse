import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getBotToken, getBotUsername } from '$lib/server/telegram/config';

export const GET: RequestHandler = async () => {
  const db = getDb();
  const username = getBotUsername(db) || null;
  return json({ enabled: !!getBotToken(db) && !!username, botUsername: username });
};
