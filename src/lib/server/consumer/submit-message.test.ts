import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import * as notify from '../notify';
import * as events from '../agent/events';
import { listMessages } from './messages';
import { submitConsumerMessage } from './submit-message';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
afterEach(() => vi.restoreAllMocks());

it('persists the message, records an event for the bell, and notifies admins', async () => {
  const spyNotify = vi.spyOn(notify, 'notifyAdminsTracked').mockResolvedValue(undefined);
  const spyEvent = vi.spyOn(events, 'recordEvent').mockReturnValue(1 as any);
  const id = await submitConsumerMessage(db, 7, 'TV wont play', 'Ana');
  expect(id).toBeGreaterThan(0);
  expect(listMessages(db, {})[0]).toMatchObject({ consumerId: 7, body: 'TV wont play' });
  expect(spyEvent).toHaveBeenCalledWith(db, expect.objectContaining({ type: 'consumer_message', title: expect.stringContaining('Ana') }));
  expect(spyNotify).toHaveBeenCalled();
});

it('rejects an empty message', async () => {
  await expect(submitConsumerMessage(db, 7, '   ', 'Ana')).resolves.toBe(0);
});
