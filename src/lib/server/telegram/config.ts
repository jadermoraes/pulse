import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { encryptSecret, decryptSecret } from '../crypto';

const TOKEN_KEY = 'telegram_bot_token';
const USERNAME_KEY = 'telegram_bot_username';

export function getBotToken(db: DB): string | null {
  const raw = getSetting(db, TOKEN_KEY);
  if (!raw) return null;
  try { return decryptSecret(raw); } catch { return null; }
}
export function setBotToken(db: DB, token: string): void {
  setSetting(db, TOKEN_KEY, token ? encryptSecret(token) : '');
}
export function getBotUsername(db: DB): string | null { return getSetting(db, USERNAME_KEY); }
export function setBotUsername(db: DB, username: string): void { setSetting(db, USERNAME_KEY, username); }
