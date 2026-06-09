const BASE = 'https://api.telegram.org';

export interface InlineButton { text: string; callback_data: string; }
export interface SendOpts { parseMode?: 'Markdown' | 'HTML'; inlineKeyboard?: InlineButton[][]; }

async function call(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({ ok: false, description: 'bad json' }));
  if (!res.ok || !data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

export function tgGetMe(token: string): Promise<{ id: number; username: string }> {
  return call(token, 'getMe', {});
}
export function tgGetUpdates(token: string, offset: number, timeoutSec: number): Promise<any[]> {
  return call(token, 'getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] });
}
export function tgSendMessage(token: string, chatId: number, text: string, opts: SendOpts = {}): Promise<any> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) body.parse_mode = opts.parseMode;
  if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
  return call(token, 'sendMessage', body);
}
export function tgSendChatAction(token: string, chatId: number, action = 'typing'): Promise<any> {
  return call(token, 'sendChatAction', { chat_id: chatId, action });
}
export function tgAnswerCallback(token: string, callbackQueryId: string, text?: string): Promise<any> {
  return call(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
}
