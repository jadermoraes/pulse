import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { getBotToken, setBotToken, getBotUsername, setBotUsername } from './config';

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

it('stores + reads back the bot token (round-trip)', () => {
  expect(getBotToken(db)).toBeNull();
  setBotToken(db, '123:ABC');
  expect(getBotToken(db)).toBe('123:ABC');
});
it('stores the bot username', () => {
  setBotUsername(db, 'pulsebot');
  expect(getBotUsername(db)).toBe('pulsebot');
});
it('clears the token when set to empty', () => {
  setBotToken(db, '123:ABC'); setBotToken(db, '');
  expect(getBotToken(db)).toBeNull();
});
