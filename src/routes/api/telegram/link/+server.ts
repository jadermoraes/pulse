import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getBotToken, getBotUsername } from '$lib/server/telegram/config';
import { mintLinkToken } from '$lib/server/telegram/bindings';
import { logAccess } from '$lib/server/identity/access-log';

export const POST: RequestHandler = async ({ locals, getClientAddress }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const db = getDb();
  const username = getBotUsername(db);
  if (!getBotToken(db) || !username) throw error(503, 'Telegram is not configured');
  const { token } = mintLinkToken(db, 'admin', locals.user.id);
  // Audit: minting an admin link grants admin-agent (write) access over Telegram once /start'd.
  logAccess(db, { type: 'telegram_link_admin', ip: getClientAddress(), detail: `admin ${locals.user.id} minted a Telegram admin link` });
  return json({ url: `https://t.me/${username}?start=${token}` });
};
