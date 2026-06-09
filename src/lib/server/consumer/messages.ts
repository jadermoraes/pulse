import type { DB } from '../db';

export interface ConsumerMessage {
  id: number; consumerId: number; body: string; status: string;
  replyBody: string | null; repliedAt: number | null;
  readByConsumer: boolean; readByAdmin: boolean; createdAt: number;
}
export interface AdminMessage extends ConsumerMessage { displayName: string | null }

function rowOf(r: any): ConsumerMessage {
  return {
    id: r.id, consumerId: r.consumer_id, body: r.body, status: r.status,
    replyBody: r.reply_body ?? null, repliedAt: r.replied_at ?? null,
    readByConsumer: !!r.read_by_consumer, readByAdmin: !!r.read_by_admin, createdAt: r.created_at
  };
}

export function createMessage(db: DB, consumerId: number, body: string): number {
  const info = db.prepare(
    'INSERT INTO consumer_messages(consumer_id, body, created_at) VALUES (?,?,?)'
  ).run(consumerId, body, Date.now());
  return Number(info.lastInsertRowid);
}

export function listMessages(db: DB, opts: { unreadOnly?: boolean }): AdminMessage[] {
  const where = opts.unreadOnly ? 'WHERE m.read_by_admin = 0' : '';
  const rows = db.prepare(
    `SELECT m.*, c.display_name AS display_name
       FROM consumer_messages m LEFT JOIN consumer_users c ON c.id = m.consumer_id
       ${where} ORDER BY m.id DESC`
  ).all() as any[];
  return rows.map((r) => ({ ...rowOf(r), displayName: r.display_name ?? null }));
}

export function listMyMessages(db: DB, consumerId: number): ConsumerMessage[] {
  return (db.prepare('SELECT * FROM consumer_messages WHERE consumer_id=? ORDER BY id DESC')
    .all(consumerId) as any[]).map(rowOf);
}

export function getMessage(db: DB, id: number): ConsumerMessage | null {
  const r = db.prepare('SELECT * FROM consumer_messages WHERE id=?').get(id) as any;
  return r ? rowOf(r) : null;
}

export function replyToMessage(db: DB, id: number, replyBody: string): ConsumerMessage | null {
  db.prepare(
    "UPDATE consumer_messages SET reply_body=?, replied_at=?, status='replied', read_by_consumer=0 WHERE id=?"
  ).run(replyBody, Date.now(), id);
  return getMessage(db, id);
}

export function markAdminRead(db: DB, id: number): void {
  db.prepare('UPDATE consumer_messages SET read_by_admin=1 WHERE id=?').run(id);
}
export function markConsumerRead(db: DB, consumerId: number): void {
  db.prepare('UPDATE consumer_messages SET read_by_consumer=1 WHERE consumer_id=? AND reply_body IS NOT NULL').run(consumerId);
}
export function adminUnreadCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) n FROM consumer_messages WHERE read_by_admin=0').get() as any).n;
}

export function addAdminRef(db: DB, chatId: number, messageId: number, consumerMessageId: number): void {
  db.prepare(
    'INSERT OR REPLACE INTO tg_admin_message_refs(chat_id, message_id, consumer_message_id) VALUES (?,?,?)'
  ).run(chatId, messageId, consumerMessageId);
}
export function refForReply(db: DB, chatId: number, messageId: number): number | null {
  const r = db.prepare(
    'SELECT consumer_message_id FROM tg_admin_message_refs WHERE chat_id=? AND message_id=?'
  ).get(chatId, messageId) as any;
  return r ? r.consumer_message_id : null;
}
