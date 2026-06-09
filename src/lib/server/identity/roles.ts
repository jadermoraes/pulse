import type { DB } from '../db';
import { CAPABILITIES, type Capability, type Role } from './types';

function assertCaps(allow: Capability[]): void {
  for (const c of allow)
    if (!CAPABILITIES.includes(c)) throw new Error(`Unknown capability: ${c}`);
}

function row(r: any): Role {
  return {
    id: r.id, name: r.name,
    allowList: JSON.parse(r.allow_list),
    monthlyTokenCap: r.monthly_token_cap,
    planName: r.plan_name ?? null,
    autoApprove: !!r.auto_approve,
    seerrQuota: JSON.parse(r.seerr_quota),
    isAdmin: !!r.is_admin,
    editable: !!r.editable,
    createdAt: r.created_at
  };
}

export interface NewRole {
  name: string;
  allowList: Capability[];
  monthlyTokenCap: number | null;
  planName?: string | null;
  autoApprove: boolean;
  seerrQuota: { movie?: number; tv?: number };
}

export function createRole(db: DB, r: NewRole): number {
  assertCaps(r.allowList);
  const info = db.prepare(
    `insert into roles (name, allow_list, monthly_token_cap, plan_name, auto_approve, seerr_quota, is_admin, editable, created_at)
     values (?,?,?,?,?,?,0,1,?)`
  ).run(r.name, JSON.stringify(r.allowList), r.monthlyTokenCap, r.planName ?? null,
    r.autoApprove ? 1 : 0, JSON.stringify(r.seerrQuota ?? {}), Date.now());
  return Number(info.lastInsertRowid);
}

export function listRoles(db: DB): Role[] {
  return (db.prepare('select * from roles order by is_admin desc, name').all() as any[]).map(row);
}

export function getRole(db: DB, id: number): Role | null {
  const r = db.prepare('select * from roles where id=?').get(id) as any;
  return r ? row(r) : null;
}

export function getAdminRole(db: DB): Role | null {
  const r = db.prepare('select * from roles where is_admin=1 limit 1').get() as any;
  return r ? row(r) : null;
}

export function updateRole(db: DB, id: number, patch: Partial<NewRole>): void {
  const cur = getRole(db, id);
  if (!cur) throw new Error('Role not found');
  if (!cur.editable) throw new Error('The Admin role is immutable');
  if (patch.allowList) assertCaps(patch.allowList);
  const next: Role = {
    ...cur,
    name: patch.name ?? cur.name,
    allowList: patch.allowList ?? cur.allowList,
    monthlyTokenCap: patch.monthlyTokenCap !== undefined ? patch.monthlyTokenCap : cur.monthlyTokenCap,
    planName: patch.planName !== undefined ? patch.planName : cur.planName,
    autoApprove: patch.autoApprove ?? cur.autoApprove,
    seerrQuota: patch.seerrQuota ?? cur.seerrQuota
  };
  db.prepare(
    `update roles set name=?, allow_list=?, monthly_token_cap=?, plan_name=?, auto_approve=?, seerr_quota=? where id=?`
  ).run(next.name, JSON.stringify(next.allowList), next.monthlyTokenCap, next.planName,
    next.autoApprove ? 1 : 0, JSON.stringify(next.seerrQuota), id);
}

export function deleteRole(db: DB, id: number): void {
  const cur = getRole(db, id);
  if (!cur) return;
  if (!cur.editable) throw new Error('The Admin role is immutable');
  db.prepare('delete from roles where id=?').run(id);
}
