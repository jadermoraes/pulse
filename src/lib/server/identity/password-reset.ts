import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

export interface PasswordReset { token: string; consumerId: number; expiresAt: number; }

const TTL_MS = 60 * 60 * 1000; // 1 hour

/** Mint a single-use reset token for a consumer. `ttlMs` override is for tests. */
export function mintReset(db: DB, consumerId: number, ttlMs: number = TTL_MS): { token: string; expiresAt: number } {
  const token = randomBytes(24).toString('hex'); // 48 hex chars
  const expiresAt = Date.now() + ttlMs;
  db.prepare('insert into password_resets (token, consumer_id, expires_at, created_at) values (?,?,?,?)')
    .run(token, consumerId, expiresAt, Date.now());
  return { token, expiresAt };
}

/** A reset is valid iff it exists, is unused, and is unexpired. */
export function getReset(db: DB, token: string): PasswordReset | null {
  const r = db.prepare('select * from password_resets where token=?').get(token) as
    | { token: string; consumer_id: number; expires_at: number; used_at: number | null } | undefined;
  if (!r || r.used_at != null || r.expires_at < Date.now()) return null;
  return { token: r.token, consumerId: r.consumer_id, expiresAt: r.expires_at };
}

/** Atomically consume a valid token; returns the consumer id. Throws if invalid/used/expired. */
export function consumeReset(db: DB, token: string): number {
  const reset = getReset(db, token);
  if (!reset) throw new Error('Invalid or expired reset token');
  const info = db.prepare('update password_resets set used_at=? where token=? and used_at is null')
    .run(Date.now(), token);
  if (info.changes !== 1) throw new Error('Reset token already used');
  return reset.consumerId;
}
