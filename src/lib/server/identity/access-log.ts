import type { DB } from '../db';

export type AccessType = 'login' | 'login_failed' | 'request' | 'chat' | 'password_reset';

export interface AccessEventInput {
  consumerId?: number | null;
  type: AccessType | string;
  ip?: string | null;
  userAgent?: string | null;
  detail?: string | null;
  ts?: number; // injectable for tests; defaults to Date.now()
}

export interface AccessEvent {
  id: number;
  consumerId: number | null;
  ts: number;
  type: string;
  ip: string | null;
  userAgent: string | null;
  detail: string | null;
}

const PRUNE_EVERY = 50; // opportunistic prune roughly every N inserts (id % N === 0)
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Best-effort access-event insert. NEVER throws into the caller — logging must not break a
 * login/request/chat flow. Opportunistically prunes old rows so the table stays bounded.
 */
export function logAccess(db: DB, e: AccessEventInput): void {
  try {
    if (!e.type) return;
    const info = db.prepare(
      'insert into access_events (consumer_id, ts, type, ip, user_agent, detail) values (?,?,?,?,?,?)'
    ).run(e.consumerId ?? null, e.ts ?? Date.now(), e.type, e.ip ?? null, e.userAgent ?? null, e.detail ?? null);
    if (Number(info.lastInsertRowid) % PRUNE_EVERY === 0) pruneAccess(db);
  } catch {
    /* swallow — never break the caller's flow */
  }
}

function row(r: Record<string, unknown>): AccessEvent {
  return {
    id: r.id as number, consumerId: (r.consumer_id as number | null) ?? null, ts: r.ts as number,
    type: r.type as string, ip: (r.ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null, detail: (r.detail as string | null) ?? null
  };
}

/** Newest-first, optionally filtered by consumer, paginated by a `before` ts cursor. */
export function listAccess(
  db: DB, opts: { consumerId?: number; before?: number; limit?: number }
): AccessEvent[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.consumerId != null) { where.push('consumer_id = ?'); args.push(opts.consumerId); }
  if (opts.before != null) { where.push('ts < ?'); args.push(opts.before); }
  const sql = `select * from access_events ${where.length ? 'where ' + where.join(' and ') : ''}
               order by ts desc, id desc limit ?`;
  return (db.prepare(sql).all(...args, limit) as Array<Record<string, unknown>>).map(row);
}

/** Delete rows older than 90 days. `nowOverride` is for tests. (`_unused` keeps a stable arity.) */
export function pruneAccess(db: DB, _unused = 0, nowOverride?: number): void {
  const now = nowOverride ?? Date.now();
  db.prepare('delete from access_events where ts < ?').run(now - NINETY_DAYS_MS);
}

/** Tiny dependency-free UA → friendly device label. '' when unknown/empty. */
export function describeDevice(ua: string | null | undefined): string {
  if (!ua) return '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  const browser =
    /Edg\//i.test(ua) ? 'Edge' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Safari\//i.test(ua) ? 'Safari' : '';
  const os =
    /Macintosh|Mac OS X/i.test(ua) ? 'Mac' :
    /Windows/i.test(ua) ? 'Windows' :
    /Linux/i.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' on ') || 'Browser';
}
