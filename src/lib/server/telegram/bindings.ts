import { randomBytes } from 'node:crypto';
import type { DB } from '../db';

export type BindKind = 'admin' | 'consumer';
export interface Binding { chatId: number; kind: BindKind; subjectId: number; conversationId: number | null; }

const TOKEN_TTL_MS = 15 * 60 * 1000;

export function mintLinkToken(db: DB, kind: BindKind, subjectId: number, ttlMs = TOKEN_TTL_MS): { token: string } {
  const token = randomBytes(18).toString('hex');
  db.prepare('insert into telegram_link_tokens (token, kind, subject_id, expires_at, used_at) values (?,?,?,?,null)')
    .run(token, kind, subjectId, Date.now() + ttlMs);
  return { token };
}
export function consumeLinkToken(db: DB, token: string): { kind: BindKind; subjectId: number } {
  const r = db.prepare('select * from telegram_link_tokens where token=?').get(token) as
    | { kind: BindKind; subject_id: number; expires_at: number; used_at: number | null } | undefined;
  if (!r || r.used_at != null || r.expires_at < Date.now()) throw new Error('Invalid or expired link token');
  const info = db.prepare('update telegram_link_tokens set used_at=? where token=? and used_at is null').run(Date.now(), token);
  if (info.changes !== 1) throw new Error('Link token already used');
  return { kind: r.kind, subjectId: r.subject_id };
}
export function bindChat(db: DB, chatId: number, kind: BindKind, subjectId: number, username: string | null): void {
  db.prepare(`insert into telegram_bindings (chat_id, kind, subject_id, username, conversation_id, created_at)
              values (?,?,?,?,null,?)
              on conflict(chat_id) do update set kind=excluded.kind, subject_id=excluded.subject_id,
                username=excluded.username, conversation_id=null`)
    .run(chatId, kind, subjectId, username, Date.now());
}
function row(r: any): Binding {
  return { chatId: r.chat_id, kind: r.kind, subjectId: r.subject_id, conversationId: r.conversation_id ?? null };
}
export function getBinding(db: DB, chatId: number): Binding | null {
  const r = db.prepare('select * from telegram_bindings where chat_id=?').get(chatId);
  return r ? row(r) : null;
}
export function getConsumerChatId(db: DB, consumerId: number): number | null {
  const r = db.prepare("select chat_id from telegram_bindings where kind='consumer' and subject_id=?").get(consumerId) as { chat_id: number } | undefined;
  return r?.chat_id ?? null;
}
export function listAdminChatIds(db: DB): number[] {
  return (db.prepare("select chat_id from telegram_bindings where kind='admin'").all() as Array<{ chat_id: number }>).map((r) => r.chat_id);
}
export function setBindingConversation(db: DB, chatId: number, conversationId: number): void {
  db.prepare('update telegram_bindings set conversation_id=? where chat_id=?').run(conversationId, chatId);
}
export function clearBindingConversation(db: DB, chatId: number): void {
  db.prepare('update telegram_bindings set conversation_id=null where chat_id=?').run(chatId);
}
export function unbind(db: DB, chatId: number): void {
  db.prepare('delete from telegram_bindings where chat_id=?').run(chatId);
}
