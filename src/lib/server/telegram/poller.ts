import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { getBotToken } from './config';
import { tgGetUpdates } from './api';
import { handleUpdate } from './handle';

const OFFSET_KEY = 'telegram_update_offset';
const LONG_POLL_SEC = 30;
let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

export async function pollOnce(db: DB, token: string): Promise<void> {
  const offset = Number(getSetting(db, OFFSET_KEY) ?? '0');
  const updates = await tgGetUpdates(token, offset, LONG_POLL_SEC);
  for (const u of updates) {
    await handleUpdate(db, u);
    setSetting(db, OFFSET_KEY, String(u.update_id + 1));
  }
}

export async function tick(db: DB): Promise<void> {
  if (_running) return;
  const token = getBotToken(db);
  if (!token) return;
  _running = true;
  try { await pollOnce(db, token); }
  catch { /* network/Telegram hiccup — next tick retries */ }
  finally { _running = false; }
}

export function startTelegramPoller(db: DB): void {
  if (_timer || process.env.PULSE_DISABLE_TELEGRAM === '1') return;
  _timer = setInterval(() => { void tick(db); }, 2000);
  if (typeof _timer === 'object' && 'unref' in _timer) (_timer as any).unref?.();
}
