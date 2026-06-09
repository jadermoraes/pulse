import type { DB } from './db';
import { sendPush } from './consumer/push';
import { getBotToken } from './telegram/config';
import { tgSendMessage } from './telegram/api';
import { getConsumerChatId, listAdminChatIds } from './telegram/bindings';
import { addAdminRef } from './consumer/messages';

export interface NotifyPayload { title: string; body: string; url?: string; }

export async function notifyConsumer(db: DB, consumerId: number, p: NotifyPayload): Promise<void> {
  await Promise.allSettled([
    sendPush(db, consumerId, { title: p.title, body: p.body, url: p.url ?? '/app' }),
    (async () => {
      const token = getBotToken(db); const chatId = getConsumerChatId(db, consumerId);
      if (token && chatId) await tgSendMessage(token, chatId, `🍿 *${p.title}*\n${p.body}`, { parseMode: 'Markdown' });
    })()
  ]);
}
export async function notifyAdmins(db: DB, p: NotifyPayload): Promise<void> {
  const token = getBotToken(db); if (!token) return;
  await Promise.allSettled(listAdminChatIds(db).map((chatId) =>
    tgSendMessage(token, chatId, `⚠️ *${p.title}*\n${p.body}`, { parseMode: 'Markdown' })));
}

/** Like notifyAdmins, but records each sent telegram message id so an admin's Telegram REPLY can
 *  be routed back to the right viewer. Best-effort per chat. */
export async function notifyAdminsTracked(db: DB, p: NotifyPayload, consumerMessageId: number): Promise<void> {
  const token = getBotToken(db); if (!token) return;
  for (const chatId of listAdminChatIds(db)) {
    try {
      const sent = await tgSendMessage(token, chatId, `⚠️ *${p.title}*\n${p.body}`, { parseMode: 'Markdown' });
      if (sent?.message_id != null) addAdminRef(db, chatId, sent.message_id, consumerMessageId);
    } catch { /* best-effort per chat */ }
  }
}
