import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as api from './api';
import { telegramChannel } from './channel';

beforeEach(() => vi.spyOn(api, 'tgSendMessage').mockResolvedValue({}));
afterEach(() => vi.restoreAllMocks());

it('buffers text deltas and posts ONE message on done', async () => {
  const ch = telegramChannel('TOK', 99);
  ch.send({ type: 'text', delta: 'Hel' }); ch.send({ type: 'text', delta: 'lo' });
  await ch.send({ type: 'done', usage: { input: 1, output: 1, total: 2 } });
  expect(api.tgSendMessage).toHaveBeenCalledTimes(1);
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 99, 'Hello', expect.anything());
});
it('posts a friendly message on cap-block', async () => {
  const ch = telegramChannel('TOK', 99);
  await ch.send({ type: 'blocked', reason: 'cap' });
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 99, expect.stringContaining('chats'), expect.anything());
});
it('posts the error on error', async () => {
  const ch = telegramChannel('TOK', 99);
  await ch.send({ type: 'error', message: 'boom' });
  expect(api.tgSendMessage).toHaveBeenCalledWith('TOK', 99, expect.stringContaining('boom'), expect.anything());
});
