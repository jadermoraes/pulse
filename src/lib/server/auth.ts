import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db';

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(pw, salt, 64);
  return `${salt.toString('hex')}:${key.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [saltHex, keyHex] = stored.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const test = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return key.length === test.length && timingSafeEqual(key, test);
}

export function isSetup(db: DB): boolean {
  return (db.prepare('select count(*) c from users').get() as any).c > 0;
}
export function createAdmin(db: DB, email: string, password: string): void {
  db.prepare('insert into users (email,password_hash,created_at) values (?,?,?)')
    .run(email, hashPassword(password), Date.now());
}
export function login(db: DB, email: string, password: string): string | null {
  const u = db.prepare('select id,password_hash from users where email=?').get(email) as any;
  if (!u || !verifyPassword(password, u.password_hash)) return null;
  const sid = randomBytes(24).toString('hex');
  db.prepare('insert into sessions (id,user_id,expires_at) values (?,?,?)')
    .run(sid, u.id, Date.now() + 1000 * 60 * 60 * 24 * 30);
  return sid;
}
export function validateSession(db: DB, sid: string): { id: number; email: string } | null {
  const s = db.prepare(`select u.id,u.email,se.expires_at from sessions se
    join users u on u.id=se.user_id where se.id=?`).get(sid) as any;
  if (!s || s.expires_at < Date.now()) return null;
  return { id: s.id, email: s.email };
}
export function destroySession(db: DB, sid: string): void {
  db.prepare('delete from sessions where id=?').run(sid);
}
