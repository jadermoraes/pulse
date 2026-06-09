import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import { addUsage, monthToDate } from '../identity/usage';
import { sseChannel } from '../agent/channel';
import { runConsumerTurn, scopeConsumerSpecs } from './consumer-turn';
import { buildToolSpecs } from '../agent/tools';
import type { AgentContext } from '../agent/types';

let db: DB; let roleId: number; let consumerId: number;
beforeEach(() => {
  process.env.PULSE_AGENT_FAKE = '1';
  db = openDb(':memory:'); migrate(db);
  roleId = createRole(db, { name: 'M', allowList: ['discover'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => { delete process.env.PULSE_AGENT_FAKE; });

function collector() {
  const events: any[] = [];
  const enc = new TextEncoder();
  const ctrl = { enqueue: (b: Uint8Array) => events.push(JSON.parse(new TextDecoder().decode(b).replace(/^data: /, '').trim())) } as any;
  return { channel: sseChannel(ctrl, enc), events };
}

describe('consumer chat integration', () => {
  it('meters usage via addUsage after a turn', async () => {
    const conv = Number(db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now()).lastInsertRowid);
    const ctx: AgentContext = { db, user: { id: 0, email: 'c' }, channel: 'web', conversationId: conv, consumer: { id: consumerId, roleId } };
    const { channel } = collector();
    await runConsumerTurn(ctx, channel, 'hi');
    expect(monthToDate(db, consumerId)).toBeGreaterThan(0);
  });

  it('denies an ungoverned admin tool (scoped toolset excludes it)', async () => {
    const ctx: AgentContext = { db, user: { id: 0, email: 'c' }, channel: 'web', conversationId: 1, consumer: { id: consumerId, roleId } };
    const scoped = scopeConsumerSpecs(await buildToolSpecs(ctx), ['discover']);
    expect(scoped.some((s) => s.name === 'listContainers')).toBe(false);
    expect(scoped.some((s) => s.name === 'restartContainer')).toBe(false);
  });

  it('at-cap blocks chat but discover/requests stay reachable', async () => {
    addUsage(db, consumerId, 1000);
    const conv = Number(db.prepare('insert into ai_conversations(title,created_at) values(?,?)').run(null, Date.now()).lastInsertRowid);
    const ctx: AgentContext = { db, user: { id: 0, email: 'c' }, channel: 'web', conversationId: conv, consumer: { id: consumerId, roleId } };
    const { channel, events } = collector();
    await runConsumerTurn(ctx, channel, 'hi');
    expect(events.some((e) => e.type === 'blocked' && e.reason === 'cap')).toBe(true);
    // discover/requests don't touch the LLM — they remain callable regardless of cap (no throw):
    const { getDiscover } = await import('./discover');
    await expect(getDiscover(db)).resolves.toBeDefined();
  });
});
