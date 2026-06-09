import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { setBotToken } from './config';
import * as api from './api';
import { pollOnce } from './poller';
import { getSetting } from '../settings';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); setBotToken(db, 'TOK'); });
afterEach(() => vi.restoreAllMocks());

it('processes updates and advances the persisted offset', async () => {
  vi.spyOn(api, 'tgGetUpdates').mockResolvedValue([
    { update_id: 10, message: { chat: { id: 1 }, text: 'hi' } },
    { update_id: 11, message: { chat: { id: 1 }, text: 'yo' } }
  ]);
  vi.spyOn(api, 'tgSendMessage').mockResolvedValue({});
  await pollOnce(db, 'TOK');
  expect(Number(getSetting(db, 'telegram_update_offset'))).toBe(12);
});
it('no-ops cleanly when getUpdates returns empty', async () => {
  vi.spyOn(api, 'tgGetUpdates').mockResolvedValue([]);
  await expect(pollOnce(db, 'TOK')).resolves.toBeUndefined();
});
