import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getBotToken, getBotUsername } from '$lib/server/telegram/config';
import { mintLinkToken, getConsumerChatId, unbind } from '$lib/server/telegram/bindings';

export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const username = getBotUsername(db);
  if (!getBotToken(db) || !username) throw error(503, 'Telegram is not configured');
  const { token } = mintLinkToken(db, 'consumer', locals.consumer.id);
  return json({ url: `https://t.me/${username}?start=${token}`, bound: getConsumerChatId(db, locals.consumer.id) != null });
};

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  return json({ enabled: !!getBotToken(db) && !!(getBotUsername(db) || null), bound: getConsumerChatId(db, locals.consumer.id) != null });
};

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();
  const chatId = getConsumerChatId(db, locals.consumer.id);
  if (chatId) unbind(db, chatId);
  return json({ ok: true });
};
