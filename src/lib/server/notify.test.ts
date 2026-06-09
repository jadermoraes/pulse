import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from './db';
import { setBotToken } from './telegram/config';
import { bindChat } from './telegram/bindings';
import * as tg from './telegram/api';
import * as push from './consumer/push';
import { refForReply } from './consumer/messages';
import { notifyConsumer, notifyAdmins, notifyAdminsTracked } from './notify';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); setBotToken(db, 'TOK');
  vi.spyOn(tg, 'tgSendMessage').mockResolvedValue({});
  vi.spyOn(push, 'sendPush').mockResolvedValue(undefined as any);
});
afterEach(() => vi.restoreAllMocks());

it('notifyConsumer hits web-push always and telegram when bound', async () => {
  bindChat(db, 500, 'consumer', 7, 'ana');
  await notifyConsumer(db, 7, { title: 'Dune', body: 'ready', url: '/app/requests' });
  expect(push.sendPush).toHaveBeenCalledWith(db, 7, expect.objectContaining({ title: 'Dune' }));
  expect(tg.tgSendMessage).toHaveBeenCalledWith('TOK', 500, expect.stringContaining('Dune'), expect.anything());
});
it('one failing channel does not break the other', async () => {
  vi.mocked(push.sendPush).mockRejectedValue(new Error('push down'));
  bindChat(db, 501, 'consumer', 8, 'b');
  await expect(notifyConsumer(db, 8, { title: 'X', body: 'y' })).resolves.toBeUndefined();
  expect(tg.tgSendMessage).toHaveBeenCalled();
});
it('notifyAdmins sends to every admin chat', async () => {
  bindChat(db, 1, 'admin', 1, 'a'); bindChat(db, 2, 'admin', 2, 'b');
  await notifyAdmins(db, { title: 'Container down', body: 'jellyfin' });
  expect(tg.tgSendMessage).toHaveBeenCalledTimes(2);
});

it('notifyAdminsTracked sends to each admin chat and records a ref per chat', async () => {
  vi.mocked(tg.tgSendMessage).mockResolvedValue({ message_id: 9001 } as any);
  bindChat(db, 555, 'admin', 1, 'a');
  await notifyAdminsTracked(db, { title: 'Message from Ana', body: 'help' }, 42);
  expect(tg.tgSendMessage).toHaveBeenCalled();
  expect(refForReply(db, 555, 9001)).toBe(42);
});

it('notifyAdminsTracked does nothing without a bot token', async () => {
  setBotToken(db, '');
  bindChat(db, 555, 'admin', 1, 'a');
  await notifyAdminsTracked(db, { title: 'x', body: 'y' }, 1);
  expect(tg.tgSendMessage).not.toHaveBeenCalled();
});
