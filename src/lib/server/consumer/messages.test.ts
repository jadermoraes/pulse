import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import {
  createMessage, listMessages, listMyMessages, replyToMessage,
  markConsumerRead, addAdminRef, refForReply, adminUnreadCount
} from './messages';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('create + list (admin) returns newest first with open status', () => {
  const a = createMessage(db, 1, 'first');
  const b = createMessage(db, 2, 'second');
  const all = listMessages(db, {});
  expect(all.map((m) => m.id)).toEqual([b, a]);
  expect(all[0]).toMatchObject({ consumerId: 2, body: 'second', status: 'open' });
});

it('reply sets reply_body/replied_at/status and resets read_by_consumer', () => {
  const id = createMessage(db, 1, 'help');
  const row = replyToMessage(db, id, 'on it');
  expect(row).toMatchObject({ status: 'replied', replyBody: 'on it', readByConsumer: false });
  expect(row!.repliedAt).toBeGreaterThan(0);
});

it('listMyMessages is scoped to one consumer', () => {
  createMessage(db, 1, 'mine');
  createMessage(db, 2, 'theirs');
  const mine = listMyMessages(db, 1);
  expect(mine).toHaveLength(1);
  expect(mine[0].body).toBe('mine');
});

it('markConsumerRead flips read_by_consumer', () => {
  const id = createMessage(db, 1, 'x');
  replyToMessage(db, id, 'y');
  markConsumerRead(db, 1);
  expect(listMyMessages(db, 1)[0].readByConsumer).toBe(true);
});

it('adminUnreadCount counts unread-by-admin', () => {
  createMessage(db, 1, 'a'); createMessage(db, 1, 'b');
  expect(adminUnreadCount(db)).toBe(2);
});

it('addAdminRef + refForReply correlate a telegram reply', () => {
  const id = createMessage(db, 1, 'a');
  addAdminRef(db, 555, 9001, id);
  expect(refForReply(db, 555, 9001)).toBe(id);
  expect(refForReply(db, 555, 1)).toBeNull();
});
