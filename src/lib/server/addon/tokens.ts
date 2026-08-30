import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

export interface AddonToken {
  token: string;
  consumerId: number;
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/**
 * Mint the household addon token, revoking any previous one.
 *
 * There is deliberately at most ONE live token. A "regenerate" must invalidate the old URL —
 * otherwise a leaked token keeps working forever and regenerating is security theatre.
 */
export function mintAddonToken(db: DB, v: { consumerId: number; label?: string | null }): string {
  const token = randomBytes(24).toString('hex'); // 48 hex chars, matching invites/password-reset
  db.transaction(() => {
    db.prepare('UPDATE addon_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
    db.prepare(
      'INSERT INTO addon_tokens(token,consumer_id,label,created_at) VALUES (?,?,?,?)'
    ).run(token, v.consumerId, v.label ?? null, Date.now());
  })();
  return token;
}

/** Null for unknown, malformed or revoked. Callers turn null into a 404, never a 401. */
export function resolveAddonToken(db: DB, token: string): { token: string; consumerId: number } | null {
  // Shape-check before touching the DB: the token arrives from a URL path, so reject anything that
  // is not exactly what mint produces rather than handing arbitrary text to a query.
  if (!/^[0-9a-f]{48}$/.test(token)) return null;
  const r = db.prepare(
    'SELECT token, consumer_id FROM addon_tokens WHERE token = ? AND revoked_at IS NULL'
  ).get(token) as { token: string; consumer_id: number } | undefined;
  return r ? { token: r.token, consumerId: r.consumer_id } : null;
}

export function touchAddonToken(db: DB, token: string): void {
  db.prepare('UPDATE addon_tokens SET last_used_at = ? WHERE token = ? AND revoked_at IS NULL')
    .run(Date.now(), token);
}

export function revokeAddonToken(db: DB): void {
  db.prepare('UPDATE addon_tokens SET revoked_at = ? WHERE revoked_at IS NULL').run(Date.now());
}

export function readAddonToken(db: DB): AddonToken | null {
  const r = db.prepare(
    'SELECT token, consumer_id, label, created_at, last_used_at FROM addon_tokens WHERE revoked_at IS NULL'
  ).get() as any;
  return r ? {
    token: r.token, consumerId: r.consumer_id, label: r.label ?? null,
    createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null
  } : null;
}
