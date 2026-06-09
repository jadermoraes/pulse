import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import { listConnections } from '../connections';
import { authenticateJellyfin } from '../provisioning/jellyfin';
import { getConsumerByJellyfinId } from './consumers';
import { getRole } from './roles';
import { logAccess } from './access-log';

export interface ConsumerSession { id: number; roleId: number; displayName: string; }

const SESSION_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days, mirrors auth.ts

/**
 * Federated login: validate username/password against Jellyfin, map the Jellyfin user id
 * to a consumer, reject disabled/unmatched users, issue a consumer session.
 * Pulse stores NO consumer password — it always re-validates against Jellyfin.
 */
export async function loginConsumer(
  db: DB, username: string, password: string,
  ctx?: { ip?: string; userAgent?: string }
): Promise<string> {
  const conn = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
  if (!conn) throw new Error('No Jellyfin connection configured');
  const jf = await authenticateJellyfin(conn, username, password);
  if (!jf) throw new Error('Invalid Jellyfin credentials');
  const consumer = getConsumerByJellyfinId(db, jf.id);
  if (!consumer) throw new Error('No Pulse account for this Jellyfin user');
  if (consumer.status === 'disabled') throw new Error('This account is disabled');

  const sid = randomBytes(24).toString('hex');
  db.prepare('insert into consumer_sessions (id, consumer_id, expires_at, created_at, ip, user_agent) values (?,?,?,?,?,?)')
    .run(sid, consumer.id, Date.now() + SESSION_TTL, Date.now(), ctx?.ip ?? null, ctx?.userAgent ?? null);
  logAccess(db, { consumerId: consumer.id, type: 'login', ip: ctx?.ip, userAgent: ctx?.userAgent });
  return sid;
}

export function validateConsumerSession(db: DB, sid: string): ConsumerSession | null {
  const s = db.prepare(
    `select cu.id, cu.role_id, cu.display_name, cu.status, cs.expires_at
       from consumer_sessions cs join consumer_users cu on cu.id = cs.consumer_id
      where cs.id = ?`
  ).get(sid) as any;
  if (!s || s.expires_at < Date.now() || s.status === 'disabled') return null;
  // Sanity: ensure the role still exists.
  if (!getRole(db, s.role_id)) return null;
  return { id: s.id, roleId: s.role_id, displayName: s.display_name };
}

export function destroyConsumerSession(db: DB, sid: string): void {
  db.prepare('delete from consumer_sessions where id=?').run(sid);
}

export interface SessionInfo {
  id: string;
  createdAt: number | null;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

/** List non-expired sessions for a consumer, newest-first (nulls sorted last). */
export function listConsumerSessions(db: DB, consumerId: number): SessionInfo[] {
  const rows = db.prepare(
    `select id, created_at, expires_at, ip, user_agent
       from consumer_sessions
      where consumer_id = ? and expires_at > ?
      order by created_at desc`
  ).all(consumerId, Date.now()) as Array<Record<string, unknown>>;
  // Rows with null created_at sort as oldest — move them to the end.
  const withTs = rows.filter((r) => r.created_at != null);
  const withoutTs = rows.filter((r) => r.created_at == null);
  return [...withTs, ...withoutTs].map((r) => ({
    id: r.id as string,
    createdAt: (r.created_at as number | null) ?? null,
    expiresAt: r.expires_at as number,
    ip: (r.ip as string | null) ?? null,
    userAgent: (r.user_agent as string | null) ?? null
  }));
}

/** Revoke (delete) a single session by its id. */
export function revokeConsumerSession(db: DB, id: string): void {
  db.prepare('delete from consumer_sessions where id=?').run(id);
}
