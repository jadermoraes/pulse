import type { DB } from '../db';
import type { Capability, ConsumerStatus, ConsumerUser, Role } from './types';

function row(r: any): ConsumerUser {
  return {
    id: r.id, roleId: r.role_id, displayName: r.display_name,
    jellyfinUserId: r.jellyfin_user_id, jellyfinUsername: r.jellyfin_username ?? null,
    seerrUserId: r.seerr_user_id,
    plexAccountId: r.plex_account_id, language: r.language,
    capOverride: r.cap_override,
    allowOverride: r.allow_override != null ? JSON.parse(r.allow_override) : null,
    status: r.status as ConsumerStatus, createdAt: r.created_at
  };
}

export interface NewConsumer { roleId: number; displayName: string; language: string; }

export function createConsumer(db: DB, c: NewConsumer): number {
  const info = db.prepare(
    `insert into consumer_users (role_id, display_name, language, status, created_at)
     values (?,?,?, 'pending', ?)`
  ).run(c.roleId, c.displayName, c.language, Date.now());
  return Number(info.lastInsertRowid);
}

export function getConsumer(db: DB, id: number): ConsumerUser | null {
  const r = db.prepare('select * from consumer_users where id=?').get(id) as any;
  return r ? row(r) : null;
}

export function getConsumerByJellyfinId(db: DB, jellyfinUserId: string): ConsumerUser | null {
  const r = db.prepare('select * from consumer_users where jellyfin_user_id=?').get(jellyfinUserId) as any;
  return r ? row(r) : null;
}

export function listConsumers(db: DB): ConsumerUser[] {
  return (db.prepare('select * from consumer_users order by id').all() as any[]).map(row);
}

export interface ConsumerPatch {
  roleId?: number;
  displayName?: string;
  language?: string;
  jellyfinUserId?: string | null;
  jellyfinUsername?: string | null;
  seerrUserId?: number | null;
  plexAccountId?: string | null;
  capOverride?: number | null;
  allowOverride?: Capability[] | null;
}

export function updateConsumer(db: DB, id: number, patch: ConsumerPatch): void {
  const cur = getConsumer(db, id);
  if (!cur) return;
  const next = { ...cur, ...patch };
  db.prepare(
    `update consumer_users set role_id=?, display_name=?, language=?, jellyfin_user_id=?,
       jellyfin_username=?, seerr_user_id=?, plex_account_id=?, cap_override=?, allow_override=? where id=?`
  ).run(
    next.roleId, next.displayName, next.language, next.jellyfinUserId,
    next.jellyfinUsername ?? null,
    next.seerrUserId, next.plexAccountId, next.capOverride,
    next.allowOverride != null ? JSON.stringify(next.allowOverride) : null, id
  );
}

export function setStatus(db: DB, id: number, status: ConsumerStatus): void {
  db.prepare('update consumer_users set status=? where id=?').run(status, id);
}

export function markActive(db: DB, id: number): void { setStatus(db, id, 'active'); }

export function deleteConsumer(db: DB, id: number): void {
  db.prepare('delete from consumer_users where id=?').run(id);
}

/** Per-user override wins (including the empty list / least-privilege); else the role's. */
export function effectiveAllowList(user: Pick<ConsumerUser, 'allowOverride'>, role: Pick<Role, 'allowList'>): Capability[] {
  return user.allowOverride != null ? user.allowOverride : role.allowList;
}

/** Per-user cap override wins (including 0); else the role cap (null = unlimited). */
export function effectiveCap(user: Pick<ConsumerUser, 'capOverride'>, role: Pick<Role, 'monthlyTokenCap'>): number | null {
  return user.capOverride != null ? user.capOverride : role.monthlyTokenCap;
}
