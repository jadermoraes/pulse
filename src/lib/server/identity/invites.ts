import { randomBytes } from 'node:crypto';
import type { DB } from '../db';
import type { Invite } from './types';

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days

function row(r: any): Invite {
  return {
    id: r.id, token: r.token, roleId: r.role_id, createdBy: r.created_by,
    expiresAt: r.expires_at, acceptedAt: r.accepted_at,
    acceptedConsumerId: r.accepted_consumer_id, createdAt: r.created_at
  };
}

export function mintInvite(db: DB, roleId: number, adminId: number, ttlMs: number = DEFAULT_TTL): Invite {
  const token = randomBytes(24).toString('hex'); // 48 hex chars, high entropy
  const now = Date.now();
  const info = db.prepare(
    `insert into invites (token, role_id, created_by, expires_at, created_at) values (?,?,?,?,?)`
  ).run(token, roleId, adminId, now + ttlMs, now);
  return getInvite(db, token) ?? { id: Number(info.lastInsertRowid) } as Invite;
}

export function getInvite(db: DB, token: string): Invite | null {
  const r = db.prepare('select * from invites where token=?').get(token) as any;
  return r ? row(r) : null;
}

export function listInvites(db: DB): Invite[] {
  return (db.prepare('select * from invites order by created_at desc').all() as any[]).map(row);
}

export function deleteInvite(db: DB, id: number): void {
  db.prepare('DELETE FROM invites WHERE id=?').run(id);
}

/**
 * Single-use, expiry-checked, role-bound. Stamps acceptance atomically; throws on
 * unknown / expired / already-accepted. Returns the role id the invite is bound to
 * (acceptance can never escalate the role — the caller MUST use this value).
 */
export function acceptInvite(db: DB, token: string, consumerId: number): number {
  const inv = getInvite(db, token);
  if (!inv) throw new Error('Invite not found');
  if (inv.acceptedAt != null) throw new Error('Invite already used');
  if (inv.expiresAt < Date.now()) throw new Error('Invite expired');
  const info = db.prepare(
    `update invites set accepted_at=?, accepted_consumer_id=?
     where token=? and accepted_at IS NULL`
  ).run(Date.now(), consumerId, token);
  if (info.changes === 0) throw new Error('Invite already used'); // lost a race
  return inv.roleId;
}
