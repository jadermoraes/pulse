import { describe, it, expect, vi, afterEach } from 'vitest';
import { tgSendMessage, tgGetUpdates, tgGetMe, tgAnswerCallback } from './api';

afterEach(() => vi.unstubAllGlobals());

it('sendMessage POSTs to the bot method URL with chat_id + text', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
  }));
  await tgSendMessage('TOK', 42, 'hi', { inlineKeyboard: [[{ text: 'A', callback_data: 'x' }]] });
  expect(calls[0].url).toContain('/botTOK/sendMessage');
  expect(calls[0].body.chat_id).toBe(42);
  expect(calls[0].body.text).toBe('hi');
  expect(calls[0].body.reply_markup.inline_keyboard[0][0].text).toBe('A');
});

it('throws on a non-ok Telegram response', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, description: 'nope' }), { status: 200 })));
  await expect(tgSendMessage('TOK', 42, 'hi')).rejects.toThrow();
});

it('getUpdates passes offset + timeout', async () => {
  const calls: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 }); }));
  await tgGetUpdates('TOK', 7, 30);
  expect(calls[0].offset).toBe(7);
  expect(calls[0].timeout).toBe(30);
});
