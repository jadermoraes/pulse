import type { DB } from './db';
import { encryptSecret, decryptSecret } from './crypto';

export interface Connection {
  id: number; type: string; name: string; baseUrl: string;
  secret: string | null; options: Record<string, unknown>; enabled: boolean;
}
type NewConn = Omit<Connection, 'id' | 'enabled'> & { enabled?: boolean };

function row(r: any): Connection {
  return { id: r.id, type: r.type, name: r.name, baseUrl: r.base_url,
    secret: r.secret != null ? decryptSecret(r.secret) : null,
    options: JSON.parse(r.options), enabled: !!r.enabled };
}
export function createConnection(db: DB, c: NewConn): number {
  const encSecret = c.secret != null ? encryptSecret(c.secret) : null;
  const info = db.prepare(`insert into connections (type,name,base_url,secret,options,enabled,created_at)
    values (?,?,?,?,?,?,?)`).run(c.type, c.name, c.baseUrl, encSecret,
    JSON.stringify(c.options ?? {}), c.enabled === false ? 0 : 1, Date.now());
  return Number(info.lastInsertRowid);
}
export function listConnections(db: DB): Connection[] {
  return (db.prepare('select * from connections order by id').all() as any[]).map(row);
}

export interface ConnectionPublic {
  id: number; type: string; name: string; baseUrl: string; enabled: boolean;
}
export function listConnectionsPublic(db: DB): ConnectionPublic[] {
  return (db.prepare('select id,type,name,base_url,enabled from connections order by id').all() as any[])
    .map((r) => ({ id: r.id, type: r.type, name: r.name, baseUrl: r.base_url, enabled: !!r.enabled }));
}
export function getConnection(db: DB, id: number): Connection | null {
  const r = db.prepare('select * from connections where id=?').get(id) as any;
  return r ? row(r) : null;
}
export function updateConnection(db: DB, id: number, patch: Partial<NewConn>): void {
  const c = getConnection(db, id); if (!c) return;
  const next = { ...c, ...patch };
  const encSecret = next.secret != null ? encryptSecret(next.secret) : null;
  db.prepare(`update connections set type=?,name=?,base_url=?,secret=?,options=?,enabled=? where id=?`)
    .run(next.type, next.name, next.baseUrl, encSecret,
      JSON.stringify(next.options ?? {}), next.enabled ? 1 : 0, id);
}
export function deleteConnection(db: DB, id: number): void {
  db.prepare('delete from connections where id=?').run(id);
}
