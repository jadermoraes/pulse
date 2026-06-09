import type { DB } from '../db';
import type { ConsumerUser, Role } from './types';
import { effectiveCap } from './consumers';

/** 'YYYY-MM' from a timestamp (defaults to now). Uses UTC so the boundary is deterministic. */
export function currentPeriod(at: number = Date.now()): string {
  const d = new Date(at);
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${d.getUTCFullYear()}-${m}`;
}

/** Atomic upsert: add `tokens` to (consumer, period). */
export function addUsage(db: DB, consumerId: number, tokens: number, at: number = Date.now()): void {
  db.prepare(
    `insert into usage_counters (consumer_id, period, tokens_used) values (?,?,?)
     on conflict(consumer_id, period) do update set tokens_used = tokens_used + excluded.tokens_used`
  ).run(consumerId, currentPeriod(at), tokens);
}

export function monthToDate(db: DB, consumerId: number, at: number = Date.now()): number {
  const r = db.prepare('select tokens_used from usage_counters where consumer_id=? and period=?')
    .get(consumerId, currentPeriod(at)) as { tokens_used: number } | undefined;
  return r ? r.tokens_used : 0;
}

/** True when month-to-date >= effective cap. A null effective cap (unlimited) is never over. */
export function isOverCap(
  db: DB,
  consumer: Pick<ConsumerUser, 'id' | 'capOverride'>,
  role: Pick<Role, 'monthlyTokenCap'>,
  at: number = Date.now()
): boolean {
  const cap = effectiveCap(consumer, role);
  if (cap == null) return false;
  return monthToDate(db, consumer.id, at) >= cap;
}

/** Days remaining until the cap resets (1st of next month, UTC) — for "resets in N days" copy. */
export function daysUntilReset(at: number = Date.now()): number {
  const d = new Date(at);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.ceil((nextMonth - at) / (24 * 60 * 60 * 1000));
}
