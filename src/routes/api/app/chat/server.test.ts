import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { createRole } from '$lib/server/identity/roles';
import { createConsumer } from '$lib/server/identity/consumers';
import { addUsage } from '$lib/server/identity/usage';
import { POST } from './+server';

let db: DB; let roleId: number; let consumerId: number;
beforeEach(() => {
  process.env.PULSE_AGENT_FAKE = '1';
  db = openDb(':memory:'); migrate(db); vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
  roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.PULSE_AGENT_FAKE; });

async function drain(res: Response): Promise<string> {
  const r = res.body!.getReader(); const dec = new TextDecoder(); let out = '';
  for (;;) { const { done, value } = await r.read(); if (done) break; out += dec.decode(value); }
  return out;
}

describe('/api/app/chat', () => {
  it('401 without a consumer', async () => {
    await expect(POST({ locals: { consumer: null }, request: new Request('http://x', { method: 'POST', body: '{}' }) } as any))
      .rejects.toMatchObject({ status: 401 });
  });

  it('streams a meta frame + meters usage for an under-cap consumer', async () => {
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    const res = await POST({ locals: { consumer: { id: consumerId, roleId, displayName: 'Ana' } }, request: req } as any);
    const text = await drain(res);
    expect(text).toContain('"type":"meta"');
    const used = db.prepare('select tokens_used from usage_counters where consumer_id=?').get(consumerId) as any;
    expect(used.tokens_used).toBeGreaterThan(0);
  });

  it('emits blocked:cap and does not start when over cap', async () => {
    addUsage(db, consumerId, 1000);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    const res = await POST({ locals: { consumer: { id: consumerId, roleId, displayName: 'Ana' } }, request: req } as any);
    expect(await drain(res)).toContain('"type":"blocked"');
  });

  it('over-cap does not create an orphan conversation row', async () => {
    addUsage(db, consumerId, 1000);
    const before = (db.prepare('select count(*) c from ai_conversations').get() as any).c;
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
    const res = await POST({ locals: { consumer: { id: consumerId, roleId, displayName: 'Ana' } }, request: req } as any);
    await drain(res);
    const after = (db.prepare('select count(*) c from ai_conversations').get() as any).c;
    expect(after).toBe(before); // no conversation materialised for a blocked turn
  });

  it('IDOR: consumer B supplying A\'s conversationId gets a fresh OWN thread, never A\'s history', async () => {
    // Consumer A owns a conversation with one user message.
    const otherId = createConsumer(db, { roleId, displayName: 'Bob', language: 'en' });
    const aConv = Number(db.prepare('insert into ai_conversations(title,created_at,consumer_id) values(?,?,?)')
      .run(null, Date.now(), otherId).lastInsertRowid);
    db.prepare('insert into ai_messages(conversation_id,role,content,tokens,ts,consumer_id) values(?,?,?,?,?,?)')
      .run(aConv, 'user', JSON.stringify({ role: 'user', content: 'A secret' }), 0, Date.now(), otherId);
    // An admin (consumer_id NULL) conversation.
    const adminConv = Number(db.prepare('insert into ai_conversations(title,created_at) values(?,?)')
      .run(null, Date.now()).lastInsertRowid);

    for (const foreignId of [aConv, adminConv]) {
      const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ message: 'hi', conversationId: foreignId }) });
      const res = await POST({ locals: { consumer: { id: consumerId, roleId, displayName: 'Ana' } }, request: req } as any);
      const text = await drain(res);
      const meta = JSON.parse(text.split('\n').find((l) => l.includes('"type":"meta"'))!.replace(/^data: /, '').trim());
      // A brand-new conversation owned by the caller — NOT the foreign one.
      expect(meta.conversationId).not.toBe(foreignId);
      const owner = (db.prepare('select consumer_id from ai_conversations where id=?').get(meta.conversationId) as any).consumer_id;
      expect(owner).toBe(consumerId);
    }
    // A's thread was never appended to (still only the original message).
    const aCount = (db.prepare('select count(*) c from ai_messages where conversation_id=?').get(aConv) as any).c;
    expect(aCount).toBe(1);
    // The admin thread was never appended to either.
    const adminCount = (db.prepare('select count(*) c from ai_messages where conversation_id=?').get(adminConv) as any).c;
    expect(adminCount).toBe(0);
  });

  it('a consumer CAN reuse their own conversationId (history preserved)', async () => {
    const myConv = Number(db.prepare('insert into ai_conversations(title,created_at,consumer_id) values(?,?,?)')
      .run(null, Date.now(), consumerId).lastInsertRowid);
    const req = new Request('http://x', { method: 'POST', body: JSON.stringify({ message: 'hi', conversationId: myConv }) });
    const res = await POST({ locals: { consumer: { id: consumerId, roleId, displayName: 'Ana' } }, request: req } as any);
    const text = await drain(res);
    const meta = JSON.parse(text.split('\n').find((l) => l.includes('"type":"meta"'))!.replace(/^data: /, '').trim());
    expect(meta.conversationId).toBe(myConv); // reused, not forked
  });
});
