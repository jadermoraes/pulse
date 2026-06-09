import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { mintLinkToken, consumeLinkToken, bindChat, getBinding, getConsumerChatId, listAdminChatIds, unbind } from './bindings';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('mint → consume is single-use and returns the subject', () => {
  const { token } = mintLinkToken(db, 'consumer', 5);
  expect(consumeLinkToken(db, token)).toEqual({ kind: 'consumer', subjectId: 5 });
  expect(() => consumeLinkToken(db, token)).toThrow();
});
it('rejects an expired token', () => {
  const { token } = mintLinkToken(db, 'admin', 1, -1000);
  expect(() => consumeLinkToken(db, token)).toThrow();
});
it('bindChat is 1:1 and upserts; lookups work', () => {
  bindChat(db, 100, 'consumer', 5, 'ana');
  expect(getBinding(db, 100)).toMatchObject({ kind: 'consumer', subjectId: 5 });
  expect(getConsumerChatId(db, 5)).toBe(100);
  bindChat(db, 100, 'admin', 1, 'boss'); // re-bind same chat overwrites
  expect(getBinding(db, 100)).toMatchObject({ kind: 'admin', subjectId: 1 });
  expect(getConsumerChatId(db, 5)).toBeNull();
});
it('listAdminChatIds returns admin chats; unbind removes', () => {
  bindChat(db, 200, 'admin', 1, 'a'); bindChat(db, 201, 'consumer', 9, 'c');
  expect(listAdminChatIds(db)).toEqual([200]);
  unbind(db, 200);
  expect(listAdminChatIds(db)).toEqual([]);
});
